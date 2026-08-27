import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * better-sqlite3 is a native addon. Next must not try to bundle it into the
   * server build: leave it external so the .node binary resolves at runtime.
   */
  serverExternalPackages: ["better-sqlite3"],

  images: {
    // The only imagery is local studio photography; no remote loaders needed.
    formats: ["image/avif", "image/webp"],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
