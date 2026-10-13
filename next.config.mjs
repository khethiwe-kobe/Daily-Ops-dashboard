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
      // Innaderm Ops dashboard (static app under public/innaderm).
      { source: '/innaderm', destination: '/innaderm/index.html' },
    ]
  },
  async headers() {
    // The Innaderm dashboard is opened inside ClickUp as an Embed view, so its
    // pages must allow ClickUp (and only ClickUp) to frame them. Next sets no
    // X-Frame-Options, so this CSP is the whole framing policy.
    const frame = "frame-ancestors 'self' https://app.clickup.com https://*.clickup.com"
    return [
      { source: '/innaderm', headers: [{ key: 'Content-Security-Policy', value: frame }] },
      { source: '/innaderm/:path*', headers: [{ key: 'Content-Security-Policy', value: frame }] },
    ]
  },
}
export default nextConfig
