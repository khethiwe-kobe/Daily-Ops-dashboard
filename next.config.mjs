/** @type {import('next').NextConfig} */
const nextConfig = {
  // The board has always lived at /support-ops, /founder and /feedback with no
  // file extension. Keep those URLs so nothing bookmarked breaks.
  async rewrites() {
    return [
      { source: '/support-ops', destination: '/support-ops.html' },
      { source: '/founder', destination: '/founder.html' },
      { source: '/feedback', destination: '/feedback.html' },
    ]
  },
}
export default nextConfig
