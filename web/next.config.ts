import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the anqa-core repo, which has its own lockfiles for
  // the Anchor workspace. Pin the root or Turbopack walks up and guesses.
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
