/** @type {import('next').NextConfig} */
const nextConfig = {
  // The board has always lived at /support-ops, /founder and /feedback with no
  // file extension. Keep those URLs so nothing bookmarked breaks.
  async rewrites() {
    return [
      { source: '/support-ops', destination: '/support-ops.html' },
      { source: '/founder', destination: '/founder.html' },
      { source: '/feedback', destination: '/feedback.html' },
      // Thornies matric dance 2026: the voting link and the live results board.
      { source: '/vote', destination: '/vote.html' },
      { source: '/matric-dance', destination: '/matric-dance.html' },
    ]
  },
}
export default nextConfig
