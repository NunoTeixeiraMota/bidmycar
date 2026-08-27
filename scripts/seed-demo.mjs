/**
 * Fills a freshly seeded auction with plausible activity — a few bidders, bids
 * on seven of the eleven spots, and approved logos — so you can see the board
 * alive without placing eleven bids by hand.
 *
 * Requires the app to be running (`npm run dev`) because it drives the real
 * HTTP API rather than writing to the database behind the app's back: that way
 * it exercises the same bidding, upload and review paths a real visitor would.
 *
 *   npm run dev            # in one terminal
 *   npm run seed:demo      # in another
 *
 * Only works in demo mode (no Stripe keys) — with keys configured a bid needs a
 * real Checkout session, and this script deliberately refuses rather than
 * pretending to have paid.
 */
import sharp from "sharp";

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_TOKEN ?? "admintoken";

const BRANDS = [
  { spot: "door-main",     amount: 32000, name: "Kestrel",   bg: "#111827", fg: "#ffffff" },
  { spot: "front-wing",    amount: 22000, name: "NOVA",      bg: "#f59e0b", fg: "#1c1917" },
  { spot: "rear-quarter",  amount: 18000, name: "Tinta",     bg: "#0f766e", fg: "#ffffff" },
  { spot: "sill",          amount: 17000, name: "LONGSHORE", bg: "#1d4ed8", fg: "#ffffff" },
  { spot: "roundel",       amount: 26000, name: "7",         bg: "#ffffff", fg: "#111111" },
  { spot: "bonnet",        amount: 12000, name: "Fern",      bg: "#166534", fg: "#ffffff" },
  { spot: "quarter-glass", amount: 13000, name: "ORBIT",     bg: "#7c3aed", fg: "#ffffff" },
];

function logoPng(brand) {
  const wide = brand.spot === "sill";
  const round = brand.spot === "roundel";
  const w = 600;
  const h = wide ? 90 : round ? 400 : 260;
  const size = round ? 260 : Math.min(h * 0.55, 90);
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" rx="${round ? w / 2 : 18}" fill="${brand.bg}"/>
    <text x="50%" y="50%" font-family="Helvetica,Arial,sans-serif" font-weight="700"
      font-size="${size}" fill="${brand.fg}" text-anchor="middle" dominant-baseline="central"
      letter-spacing="${wide ? 8 : 1}">${brand.name}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const jars = new Map();
async function call(path, options = {}, who = "anon") {
  const headers = { ...(options.headers ?? {}) };
  if (jars.has(who)) headers.cookie = jars.get(who);
  const res = await fetch(BASE + path, { ...options, headers, redirect: "manual" });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) jars.set(who, setCookie.map((c) => c.split(";")[0]).join("; "));
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 200) };
  }
}

const state = await fetch(BASE + "/api/auction/state").catch(() => null);
if (!state || !state.ok) {
  console.error(`Cannot reach ${BASE}. Start the app first:  npm run dev`);
  process.exit(1);
}
if ((await state.json()).spots.length === 0) {
  console.error("No spots in the database. Run `npm run seed` first.");
  process.exit(1);
}

let placed = 0;
for (const brand of BRANDS) {
  const email = `${brand.name.toLowerCase().replace(/\W/g, "")}@example.com`;
  const bid = await call(
    "/api/bids",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spotKey: brand.spot,
        amountCents: brand.amount,
        email,
        displayName: brand.name,
      }),
    },
    email,
  );

  if (!bid.body?.ok) {
    console.log(`  ${brand.spot.padEnd(14)} skipped — ${bid.body?.message ?? bid.status}`);
    continue;
  }
  if (!bid.body.demo) {
    console.error(
      "\nStripe keys are configured, so this bid needs a real payment and cannot be faked.\n" +
        "Unset STRIPE_SECRET_KEY to run the demo seeder.",
    );
    process.exit(1);
  }

  const form = new FormData();
  form.append("bidId", bid.body.bidId);
  form.append(
    "file",
    new Blob([await logoPng(brand)], { type: "image/png" }),
    `${brand.name.toLowerCase()}.png`,
  );
  const upload = await call("/api/artwork", { method: "POST", body: form }, email);
  if (!upload.body?.ok) {
    console.log(`  ${brand.spot.padEnd(14)} bid ok, upload failed — ${upload.body?.message ?? upload.status}`);
    continue;
  }

  const review = await call(
    `/api/admin/artwork/${upload.body.artworkId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": ADMIN },
      body: JSON.stringify({ decision: "approve" }),
    },
    "admin",
  );
  const approved = review.body?.ok === true;
  console.log(
    `  ${brand.spot.padEnd(14)} €${brand.amount / 100} · ${brand.name}` +
      (approved ? " · logo approved" : ` · logo pending (admin said ${review.status})`),
  );
  placed += 1;
}

const final = await (await fetch(BASE + "/api/auction/state")).json();
const pending = final.spots.filter((s) => s.holder?.artworkPending).length;

console.log(
  `\n${placed} spots taken \u00b7 \u20ac${final.totalRaisedCents / 100} raised of ` +
    `\u20ac${final.goalCents / 100} (${final.goalPercent}%)`,
);
if (pending > 0) {
  console.log(
    `${pending} logo(s) still awaiting review \u2014 ADMIN_TOKEN did not match the server's.\n` +
      "Approve them at /admin, or re-run with the same ADMIN_TOKEN the server was started with.",
  );
}
console.log(`Open ${BASE} to see the board.`);
