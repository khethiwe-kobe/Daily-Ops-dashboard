export const metadata = { title: 'Serentia Ops', description: 'Support command centre' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>{children}</body>
    </html>
  )
}
