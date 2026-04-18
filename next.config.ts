/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // 전송 용량을 10MB로 확대
    },
  },
};

export default nextConfig;
