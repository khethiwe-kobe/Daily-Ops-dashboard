// Vote tallying for the matric dance. Voters type names freely, so the same
// person arrives as "Thabo Mokoena", "thabo mokoena", "Thabo Mokeona" and
// "Thabo M". Matching is deliberately tight: a vote only folds into an
// existing candidate when the names are very close, so two different people
// with similar names stay apart.

export function normalizeName(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents: "Zoë" -> "zoe"
    .toLowerCase()
    .replace(/['’`.]/g, '')              // "o'neil" -> "oneil", "j.p." -> "jp"
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')                  // "mary-jane" -> "mary jane"
    .replace(/\s+/g, ' ')
    .trim()
}

export function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

// How many typos we forgive on the space-stripped name. Short names get none:
// "Ava" and "Eva" are different people.
function allowance(len) {
  if (len < 6) return 0
  if (len < 10) return 1
  return 2
}

// True when two normalised names are near-certainly the same person.
// First names must agree (exactly, or one typo in a name of five+ letters):
// "Ava Naidoo" and "Eva Naidoo" stay separate, "Thabo Mokoena" and
// "Thabo Mokeona" merge. Single-word names only merge on an exact match here;
// tally() folds a lone first name into a full name when it is unambiguous.
export function namesMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const ca = a.replace(/ /g, ''), cb = b.replace(/ /g, '')
  if (ca === cb) return true
  const ta = a.split(' '), tb = b.split(' ')
  if (ta.length === 1 || tb.length === 1) return false
  const fa = ta[0], fb = tb[0]
  const firstOk = fa === fb || (fa.length >= 5 && fb.length >= 5 && editDistance(fa, fb) <= 1)
  if (!firstOk) return false
  if (editDistance(ca, cb) <= allowance(Math.min(ca.length, cb.length))) return true
  // Same number of words, each word within one typo ("thabo mokeona").
  if (ta.length === tb.length) {
    return ta.every((w, i) => w.length >= 4 && tb[i].length >= 4 && editDistance(w, tb[i]) <= 1)
  }
  return false
}

function display(s) {
  return /[A-Z\u00C0-\u00DE]/.test(s) ? s : s.replace(/(^|[\s'-])([a-z\u00DF-\u00FF])/g, (m, p, c) => p + c.toUpperCase())
}

// Groups raw name strings into candidates. Returns candidates sorted by votes,
// each with the spelling voters used most and every other spelling it absorbed.
export function tally(rawNames) {
  const spellings = new Map() // normalised -> { raw spellings -> count }
  for (const raw of rawNames) {
    const norm = normalizeName(raw)
    if (!norm) continue
    const clean = String(raw).replace(/\s+/g, ' ').trim()
    const lower = clean.toLowerCase()
    const entry = spellings.get(norm) || { norm, total: 0, raws: new Map() }
    entry.total++
    // Group by lowercase, but remember how each voter actually typed it so
    // the board shows the most common real casing ("Zoë van der Merwe").
    const r = entry.raws.get(lower) || { count: 0, forms: new Map() }
    r.count++
    r.forms.set(clean, (r.forms.get(clean) || 0) + 1)
    entry.raws.set(lower, r)
    spellings.set(norm, entry)
  }

  // Most-voted spelling claims a cluster first, so a typo merges into the real
  // name rather than the other way round.
  const entries = [...spellings.values()].sort((a, b) => b.total - a.total || a.norm.localeCompare(b.norm))
  const clusters = []
  for (const e of entries) {
    const home = clusters.find((c) => namesMatch(c.norm, e.norm))
    if (home) home.members.push(e)
    else clusters.push({ norm: e.norm, members: [e] })
  }

  // First-name-only votes ("Thabo") join a full name only when exactly one
  // candidate has that first name. Otherwise the vote stays on its own, which
  // the dashboard shows so the organiser can see it.
  const singles = clusters.filter((c) => !c.norm.includes(' '))
  for (const s of singles) {
    const matches = clusters.filter((c) => c !== s && c.norm.includes(' ') && c.norm.split(' ')[0] === s.norm)
    if (matches.length === 1) {
      matches[0].members.push(...s.members)
      clusters.splice(clusters.indexOf(s), 1)
    }
  }

  return clusters.map((c) => {
    const raws = new Map()
    let votes = 0
    for (const m of c.members) {
      votes += m.total
      for (const [lower, r] of m.raws) {
        const t = raws.get(lower) || { count: 0, forms: new Map() }
        t.count += r.count
        for (const [f, n] of r.forms) t.forms.set(f, (t.forms.get(f) || 0) + n)
        raws.set(lower, t)
      }
    }
    // Display the spelling most voters used; on a tie prefer the fuller name.
    const words = (s) => s.split(' ').length
    const ordered = [...raws.entries()].sort((a, b) =>
      b[1].count - a[1].count || words(b[0]) - words(a[0]) || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    const best = (t) => [...t.forms.entries()].sort((a, b) => b[1] - a[1] || (/[A-Z]/.test(b[0]) ? 1 : 0) - (/[A-Z]/.test(a[0]) ? 1 : 0))[0][0]
    const name = display(best(ordered[0][1]))
    const variants = ordered.slice(1).map(([, t]) => display(best(t)))
    return { name, votes, variants }
  }).sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))
}
