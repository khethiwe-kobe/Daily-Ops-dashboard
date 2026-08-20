const LINKS = [
  ['/support-ops', 'Support board', 'Every ticket, one click from its chat'],
  ['/feedback', 'Customer feedback', 'Themes, praise, complaints, recommendations'],
  ['/api/health', 'Health check', 'Is the database wired up'],
]

export default function Home() {
  return (
    <main style={{ maxWidth: 620, margin: '0 auto', padding: '56px 20px', color: '#241B2B' }}>
      <h1 style={{ fontFamily: 'Georgia, serif', color: '#4A2C5A', fontSize: 34, marginBottom: 6 }}>Serentia Ops</h1>
      <p style={{ color: '#6B6070', marginTop: 0 }}>Support command centre.</p>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: 28 }}>
        {LINKS.map(([href, title, blurb]) => (
          <li key={href} style={{ border: '1px solid #E4DCE9', borderRadius: 14, padding: '14px 16px', marginBottom: 10, background: '#fff' }}>
            <a href={href} style={{ color: '#4A2C5A', fontWeight: 700, textDecoration: 'none', fontSize: 16 }}>{title}</a>
            <div style={{ color: '#6B6070', fontSize: 13.5, marginTop: 2 }}>{blurb}</div>
          </li>
        ))}
      </ul>
    </main>
  )
}
