/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Genera .next/standalone: un server.js minimo sin node_modules, ideal
  // para una imagen Docker liviana (ver fronted/Dockerfile).
  output: 'standalone',
};

module.exports = nextConfig;
