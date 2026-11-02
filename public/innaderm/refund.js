/* Innaderm refund decision matrix, shared by the Refund matrix tab and the
   "Refund check" box on support-board tickets.

   Source: the published refund policy (innaderm.com/policies/refund-policy,
   last updated 17 Sep 2026) and the draft matrix in the Serentia KB
   (knowledge-base/15-innaderm-refund-matrix.md), built from 116 past refund
   cases. The policy wins wherever they differ. Calvin has not signed the
   matrix off yet: STATUS below says so on screen.

   assess(ticket) only ever suggests. It never refunds, cancels or sends:
   a person does the action, checks it happened, then sends the reply. */
;(() => {
  'use strict'

  const STATUS = {
    approved: false,
    policyUpdated: '17 Sep 2026',
    note: 'Calvin has not approved the matrix yet. Until he does, every refund still needs his OK (handover, 4 Oct); the published policy answers are safe to quote.',
  }

  const POLICY = [
    ['90-day guarantee', 'First order only (one-time or the first order of a subscription). One email with the order number within 90 days of the carrier-confirmed delivery date is the whole process: no minimum use, no reason, no replacement first.'],
    ['Conditions (all five)', 'First order · within 90 days of carrier delivery · bought on innaderm.com · no earlier guarantee refund to that person, household, address or card · no chargeback or dispute on the order.'],
    ['What is refunded', 'The product price of the first order. Never shipping, handling, expedited or priority fees. Gift cards are not refundable.'],
    ['Returns', 'Keep what is left. Returns are not required and will not be accepted.'],
    ['After a guarantee refund', 'Any subscription tied to that order is cancelled. Future orders from that customer, household, address or card are not covered.'],
    ['Not eligible', 'After 90 days · any order after the first (renewals, repeat purchases) · renewal charges, incl. ones not cancelled 48 h before billing · anyone already refunded under the guarantee · orders with a chargeback · unauthorised resellers.'],
    ['Subscriptions', 'Auto-renew until cancelled. Cancel any time; at least 48 hours before the next billing date to avoid that charge.'],
    ['Wrong / damaged / missing / open', 'Every order: free replacement of the affected item if claimed within 7 days of carrier delivery with the order number and a clear photo. Later orders: replacement is the only remedy.'],
    ['Lost / undelivered', 'Customer emails within 30 days of the ship date; we open a carrier investigation. Confirmed lost: free replacement. Marked delivered to the address given: no replacement or refund. Wrong address from the customer: not our responsibility.'],
    ['Fair use', 'We may decline abuse, fraud, reselling, multiple identities, repeated damaged/missing claims, or claims contradicted by carrier or photo evidence.'],
    ['Disputes', 'Customers agree to contact us first; most issues resolved in 1-2 business days. A filed chargeback ends the guarantee and replacement for that order.'],
    ['Timeline', 'Reviewed within 1-2 business days. Refund issued in 3-7 business days, plus 3-5 for the bank.'],
    ['EU', '14-day cooling-off period under distance-selling rules, separate from the guarantee.'],
  ]

  const ROWS = [
    { id: 'R1', title: 'Not shipped yet, asks to cancel', policy: 'Cancellation Policy page (not reviewed yet).', team: 'Same day: hold it in Shopify/Zendrop, then cancel + full refund (nothing shipped, so shipping too). One retention line allowed. Never answer a pre-shipment cancel after it ships.', calvin: 'It shipped before we saw the request.' },
    { id: 'R2', title: 'In transit, slower than estimated', policy: 'Lost/undelivered: carrier investigation; replacement only if confirmed lost.', team: 'Tracking + honest ETA. No cancel, no partial refund. WELCOME15 as an apology is fine. First order: the 90-day guarantee starts on delivery. Past the estimate with no movement: open a carrier investigation (R3).', calvin: 'Customer insists on money back for a parcel still moving.' },
    { id: 'R3', title: 'Lost (carrier confirms, returned to sender, long customs hold)', policy: 'Claim within 30 days of ship date; carrier investigation; free replacement if confirmed lost.', team: 'Open the investigation with Zendrop the same day. Confirmed lost: free replacement. Not a refund, not both.', calvin: 'Customer refuses a replacement and wants money back. Claim over 30 days after shipping.' },
    { id: 'R4', title: 'Marked delivered, not found', policy: 'Delivered to the address given = not eligible.', team: 'Ask them to check neighbours, mailroom, household. Request proof of delivery from Zendrop. POD at their address: decline kindly, share the photo, WELCOME15.', calvin: 'POD photo/GPS shows a different address or door. Repeat "not received" claims.' },
    { id: 'R5', title: 'Wrong, damaged, defective, missing, open or tampered', policy: 'Free replacement of the affected item, any order, within 7 days of delivery with a photo.', team: 'Within 7 days with a photo: replace the affected item, no return. No photo: ask once. First order: they may choose the guarantee refund (R8) instead.', calvin: 'After 7 days on a later order. Repeat claims. Photo contradicts the claim.' },
    { id: 'R6', title: 'Changed mind / "doesn\'t work" on a later order', policy: 'Any order after the first is not eligible for a refund.', team: 'First order: R8. Later order: decline kindly, offer to cancel or pause the subscription, WELCOME15.', calvin: 'Customer threatens a dispute after the decline.' },
    { id: 'R7', title: 'Reaction, allergy, medication interaction, pregnancy/nursing', policy: 'No separate rule. First order: the guarantee.', team: 'Stop taking it; see a doctor if symptoms continue. First order: R8 refund. Cancel any subscription.', calvin: 'Later order (history refunded all of these). Severe reaction (swelling, breathing, hospital): same day, and log it.' },
    { id: 'R8', title: '90-day guarantee claim', policy: 'All five conditions: first order, within 90 days of delivery, innaderm.com, no earlier guarantee refund, no chargeback.', team: 'All true: refund the product price (not shipping) within 1-2 business days, keep the product, cancel the subscription in Loop. No conditions on use or reasons. Any false: decline kindly, name the condition, WELCOME15.', calvin: 'Eligibility unclear, or the customer disputes a decline.' },
    { id: 'R9', title: '"Cancel my subscription"', policy: 'Cancel any time; 48 hours before billing to avoid that charge.', team: 'Cancel it (not pause). Confirm only once Loop shows it cancelled. One line offering a pause instead is fine.', calvin: 'Never needed.' },
    { id: 'R10', title: 'Renewal charged after they asked us to cancel 48+ h before billing', policy: 'The policy covers customers who did not cancel; this one did, by email.', team: 'Our error: refund the renewal in full, cancel the subscription, keep the product.', calvin: 'Request came less than 48 h before billing (then R11).' },
    { id: 'R11', title: 'Renewal they forgot to cancel', policy: 'Renewal charges are not eligible for refund.', team: 'Cancel future renewals now. Decline the refund kindly, quoting the 48-hour line.', calvin: 'Renewal not shipped yet: whether to cancel and refund before it ships.' },
    { id: 'R12', title: 'Chargeback threatened', policy: 'Customers agree to contact us first; a filed dispute ends the guarantee and replacement.', team: 'Reply the same day with whatever row applies. Mention once, kindly, that we resolve it in 1-2 business days and a dispute ends the guarantee. A threat earns nothing beyond policy.', calvin: 'Still threatening after the policy answer.' },
    { id: 'R13', title: 'Chargeback / dispute already filed', policy: 'No guarantee, no replacement; we respond with records.', team: 'Do not refund separately (that pays twice). Do not reply on the dispute.', calvin: 'Always.' },
    { id: 'R14', title: 'Double charge / wrong bundle charged', policy: 'Billing error, not a refund request.', team: 'Refund the extra charge in full, same day.', calvin: 'Never needed.' },
    { id: 'R15', title: '"I never placed this order" / possible fraud', policy: 'Fair use: fraud.', team: 'Hold the order. Nothing else.', calvin: 'Always, same day.' },
    { id: 'R16', title: 'Address problems', policy: 'Not responsible for a wrong or incomplete address the customer gave.', team: 'Not shipped: fix the address. Shipped wrong because of us: reship free. Customer error and shipped: decline kindly.', calvin: 'Customer error, but a sympathetic case.' },
    { id: 'R17', title: 'EU customer within 14 days of delivery', policy: '14-day cooling-off, separate from the guarantee.', team: 'Do not decline under the guarantee rules.', calvin: 'Always.' },
  ]

  const ALWAYS_CALVIN = [
    'Refund total for the customer over $80 in the last 90 days (limit pending Calvin)',
    'Legal threat, lawyer, regulator, attorney general, BBB',
    'Severe reaction or anything medical beyond a mild rash or allergy',
    'Fraud, an unrecognised order, a filed dispute, or a fair-use red flag',
    'A situation no row covers',
    'The customer has rejected the policy answer twice',
  ]

  const DECISIONS = [
    'Apply the published policy without asking Calvin each time (guarantee refunds, replacements, cancellations)?',
    'Refund ceiling above which he still sees it ($80 suggested).',
    'Goodwill beyond the policy: stop it, except later-order reactions and unshipped forgotten renewals, which go to him case by case?',
    'Pre-shipment cancels: full refund including shipping (confirm against the Cancellation Policy page).',
  ]

  const LIMIT = 80
  const DAY = 86400e3
  const days = (a, b = Date.now()) => Math.floor((new Date(b) - new Date(a)) / DAY)
  const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : '')
  const money = (n) => '$' + Number(n || 0).toFixed(2)

  const REFUND_TYPES = new Set(['Chargeback / dispute threat', 'Adverse reaction', 'Subscription', 'Cancel order', 'Refund / return', 'Damaged / wrong / missing item', 'Marked delivered, not received', 'Billing / payment', 'Not working / results'])
  const RX = {
    money: /refund|money back|reimburs|guarantee|cancel|charge ?back|dispute|return (it|this|them|the|my)|send (it|this|them) back/,
    filed: /(filed|opened|started|raised|submitted|initiated) (a |the )?(dispute|chargeback|claim)|disputed (the|this) charge|bank (has|is) (reversing|investigating)/,
    threat: /charge ?back|dispute|my bank|credit card company|paypal (claim|case)/,
    legal: /\bbbb\b|better business|lawyer|attorney|legal action|\bsue\b|ftc|attorney general/,
    fraud: /never (ordered|placed|made|bought)|didn.?t (order|place|make|buy) (this|it|an?|the)|did not (order|place)|not my order|fraud|unauthori[sz]ed|stolen card|someone (used|ordered)/,
    severe: /swell|breath|hospital|\ber\b|emergency|anaphyla|throat|faint/,
    reaction: /rash|allerg|reaction|hives|nause|vomit|made me (sick|ill)|side effect|feel (sick|unwell|bad|awful)|didn.?t (make me )?feel (good|well)|pregnan|nursing|breastfeed|medication|doctor|oncolog/,
    double: /charged (me )?twice|double charge|two charges|charged two times|duplicate charge/,
    damaged: /damag|broken|leak|crush|wrong (item|product)|missing|only (got|received) \w+|opened|tampered|empty/,
    notFound: /(says|shows|marked|tracking).{0,25}delivered|delivered.{0,40}(not|never|didn.?t|can.?t find)|not in (my )?mailbox|stolen/,
    lost: /lost|returned to sender|return to sender|customs|stuck|no (update|movement)|hasn.?t moved/,
    sub: /subscri|renewal|renewed|recurring|charged again|another (order|charge|shipment)|auto.?ship/,
    cancel: /cancel/,
    address: /address/,
  }

  function textOf(t) { return `${t.subject || ''}\n${t.excerpt || ''}\n${t.lastExcerpt || ''}`.toLowerCase() }

  // The order the claim is about: the one they named, else the newest.
  function focusOrder(t) {
    const os = (t.orders || []).filter((o) => !o.cancelledAt)
    return os.find((o) => (t.orderNumbers || []).includes(o.name)) || os[0] || (t.orders || [])[0] || null
  }
  function firstOrder(t) {
    if (t.firstOrder) return t.firstOrder
    const os = (t.orders || []).filter((o) => !o.cancelledAt)
    return os.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null
  }
  const stage = (o) => (!o ? 'unknown' : o.cancelledAt ? 'cancelled' : o.deliveredAt ? 'delivered' : o.fulfilledAt || o.trackingNumber ? 'transit' : 'unshipped')

  function pickRow(t, text, o) {
    const flags = t.flags || []
    if (RX.filed.test(text)) return 'R13'
    if (RX.fraud.test(text)) return 'R15'
    if (t.category === 'Adverse reaction' || flags.includes('reaction') || RX.reaction.test(text)) return 'R7'
    if (RX.double.test(text)) return 'R14'
    if (t.category === 'Damaged / wrong / missing item' || (RX.damaged.test(text) && stage(o) === 'delivered')) return 'R5'
    if (t.category === 'Marked delivered, not received' || RX.notFound.test(text)) return 'R4'
    if (RX.lost.test(text) && stage(o) !== 'delivered') return 'R3'
    if (t.category === 'Subscription' || RX.sub.test(text)) {
      if (/refund|money back|charged/.test(text) && o?.subscription && o !== firstOrder(t)) return 'R11'
      if (RX.cancel.test(text) && !/refund|money back/.test(text)) return 'R9'
    }
    const s = stage(o)
    if (s === 'unshipped') return 'R1'
    if (s === 'transit') return 'R2'
    if (s === 'delivered') {
      const fo = firstOrder(t)
      return fo && o && fo.name !== o.name ? 'R6' : 'R8'
    }
    return 'R8'
  }

  function assess(t) {
    const text = textOf(t)
    const flags = t.flags || []
    const relevant = REFUND_TYPES.has(t.category) || RX.money.test(text) || flags.includes('chargeback')
    if (!relevant) return null
    const o = focusOrder(t)
    const fo = firstOrder(t)
    const row = pickRow(t, text, o)
    const def = ROWS.find((r) => r.id === row)
    const checks = []
    const add = (label, value, state) => checks.push({ label, value, state })
    let escalate = null

    if (!o) add('Order', 'No order found: ask for the #INN number before deciding', 'warn')
    else add('Order', `${o.name} · ${money(o.total)} incl. shipping · ${stage(o) === 'delivered' ? 'delivered ' + fmt(o.deliveredAt) : stage(o) === 'transit' ? 'shipped ' + fmt(o.fulfilledAt) : stage(o)}`, 'info')

    const isFirst = o && fo ? fo.name === o.name : null
    const count = t.orderCount ?? (t.orders || []).filter((x) => !x.cancelledAt).length
    if (['R5', 'R6', 'R7', 'R8'].includes(row)) {
      add('First order?', isFirst == null ? 'Unknown' : isFirst ? `Yes (${count} order${count === 1 ? '' : 's'} on this email)` : `No: first order was ${fo.name} on ${fmt(fo.createdAt)}`, isFirst == null ? 'warn' : isFirst ? 'ok' : 'bad')
    }
    if (['R6', 'R7', 'R8'].includes(row) && o) {
      if (o.deliveredAt) {
        const d = days(o.deliveredAt)
        add('Within 90 days of delivery?', `Day ${d} of 90 (delivered ${fmt(o.deliveredAt)})`, d <= 90 ? 'ok' : 'bad')
      } else add('Within 90 days of delivery?', 'No carrier delivery date in Shopify: check tracking', 'warn')
      const refunded = (t.orders || []).filter((x) => /refund/i.test(x.financial || ''))
      add('Earlier refund on record?', refunded.length ? `Yes: ${refunded.map((x) => x.name).join(', ')} (check if it was a guarantee refund)` : 'None on this email. Check household, address and card in Shopify', refunded.length ? 'bad' : 'warn')
      add('Chargeback on the order?', flags.includes('chargeback') ? 'Customer mentions a dispute: check Shopify before refunding' : 'None mentioned. Check Shopify', flags.includes('chargeback') ? 'bad' : 'ok')
    }
    if (row === 'R5' && o) {
      const d = o.deliveredAt ? days(o.deliveredAt) : null
      add('Within 7 days of delivery?', d == null ? 'No delivery date: check tracking' : `Day ${d} of 7`, d == null ? 'warn' : d <= 7 ? 'ok' : 'bad')
      add('Photo sent?', 'Check the email for a photo (and of the packaging if damaged)', 'warn')
    }
    if (row === 'R3' && o?.fulfilledAt) { const d = days(o.fulfilledAt); add('Within 30 days of ship date?', `Day ${d} of 30`, d <= 30 ? 'ok' : 'bad') }
    if (row === 'R1') add('Still unshipped?', 'Check Zendrop before cancelling: hold it first', 'warn')
    if (row === 'R10' || row === 'R11') add('Asked to cancel 48 h+ before billing?', 'Check their earlier emails against the renewal date: if yes, it is R10 (our error, refund)', 'warn')

    // Escalation
    if (RX.legal.test(text) || flags.includes('legal')) escalate = 'Legal threat'
    else if (row === 'R13') escalate = 'Chargeback or dispute filed'
    else if (row === 'R15') escalate = 'Unrecognised order / possible fraud'
    else if (row === 'R7' && RX.severe.test(text)) escalate = 'Severe reaction: same day'
    else if (row === 'R7' && isFirst === false) escalate = 'Reaction on a later order (policy: no refund)'
    else if (row === 'R4' && /wrong (address|house|door)|not my (house|door|address)|different address/.test(text)) escalate = 'Proof of delivery shows another address'
    else if (row === 'R11' && stage(o) === 'unshipped') escalate = 'Unshipped forgotten renewal: refund before it ships?'
    else if (['R8', 'R7', 'R1', 'R10', 'R14'].includes(row) && o && o.total > LIMIT) escalate = `Over the ${money(LIMIT)} limit`
    else if (!STATUS.approved && ['R1', 'R7', 'R8', 'R10', 'R14'].includes(row)) escalate = 'Refund approval (matrix not signed off yet)'

    const eligible = row === 'R8' ? checks.filter((c) => c.label !== 'Order').every((c) => c.state === 'ok' || c.state === 'warn') && !checks.some((c) => c.state === 'bad') : null
    let decision = def.team
    if (row === 'R8') decision = eligible ? 'Looks eligible: refund the product price (not shipping), keep the product, cancel the subscription. Confirm the amber checks first.' : 'A condition fails: decline kindly, name the condition, offer WELCOME15. (Later order? Use R6.)'

    return { row, def, checks, decision, escalate, eligible, order: o, isFirst, reply: reply(row, t, o, eligible) }
  }

  // ---------- replies ----------
  function reply(row, t, o, eligible) {
    const v = t.vars || {}
    const name = v.first_name || 'there'
    const ord = o?.name || v.order_number || '[ORDER NUMBER]'
    const code = v.discount_code || 'WELCOME15'
    // Upper-case only the characters the composer's placeholder check accepts,
    // so 'Put in Gmail' stays blocked until the agent deletes this line.
    const B = (s) => `[BEFORE SENDING: ${s.toUpperCase().replace(/[^A-Z0-9 ,.:;'’()/&+-]/g, '')}. DELETE THIS LINE.]\n\n`
    const sign = '\n\nWarm regards,\n{agent}'
    const timeline = 'You\'ll see it on your original payment method within 3-7 business days, and your bank may take another 3-5 business days to post it.'
    const T = {
      R1: B(`check zendrop it has not shipped, cancel ${ord} in shopify with a full refund`) + `Hi ${name},\n\nThank you for letting us know. I've cancelled your order ${ord} before it shipped and refunded it in full. ${timeline}\n\nIf you ever want to give InnaDerm another try, just reply here and I'll help you get started.` + sign,
      R2: `Hi ${name},\n\nI'm sorry it's taking longer than expected. ${v.order_status || ''}\n\nOnce a parcel is with the carrier we can't recall it, but it is on its way to you. If it hasn't moved by [DATE], reply here and I'll open a carrier investigation straight away.${'\n\n'}Your 90-day money-back guarantee only starts on the day it's delivered, so you don't lose any of it while you wait. As a thank-you for your patience, here's ${code} for 15% off your next order.` + sign,
      R3: B('open the carrier investigation with zendrop and add the date below') + `Hi ${name},\n\nI'm sorry your parcel hasn't arrived. I've opened an investigation with the carrier for ${ord}, which usually takes [NUMBER] business days. If they confirm it's lost, we'll send you a free replacement straight away, and I'll email you the new tracking number the day it ships.` + sign,
      R4: B('request proof of delivery from zendrop first') + `Hi ${name},\n\nI'm sorry you haven't been able to find your parcel. ${v.order_status || ''}\n\nCould you check with neighbours, your mailroom or anyone in your household who might have picked it up? Parcels sometimes turn up a day or two after they're marked delivered. In the meantime I've asked the carrier for the proof of delivery, and I'll share it with you as soon as I have it.` + sign,
      R5: `Hi ${name},\n\nI'm so sorry your order ${ord} didn't arrive as it should. Could you reply with a clear photo of the issue (and of the packaging, if it was damaged)? As soon as I have it, I'll send a free replacement of the affected item, and there's no need to send anything back.` + sign,
      R6: `Hi ${name},\n\nThank you for telling me, and I'm sorry InnaDerm hasn't worked the way you hoped. Our 90-day money-back guarantee covers a customer's first order, and ${ord} was a later order, so I'm not able to refund it.\n\nWhat I can do is make sure nothing else is sent or charged: just say the word and I'll cancel or pause your subscription today. And if you'd like to try again later, ${code} gives you 15% off.` + sign,
      R7: B('confirm first order and day count above, refund the product price (not shipping) in shopify, cancel the subscription in loop') + `Hi ${name},\n\nI'm so sorry to hear that. Please stop taking it, and if anything continues, check in with your doctor.\n\nI've refunded your order ${ord} for the product price of [AMOUNT], and cancelled your subscription so nothing more is sent. There's nothing to send back. ${timeline}\n\nI hope you feel better soon.` + sign,
      R8: eligible === false
        ? `Hi ${name},\n\nThank you for reaching out, and I'm sorry InnaDerm hasn't given you the results you were hoping for. Our 90-day money-back guarantee [NAME THE CONDITION, E.G. COVERS THE FIRST ORDER ONLY], so I'm not able to refund ${ord} under it.\n\nI'm happy to cancel or pause your subscription today so nothing else is sent, and ${code} gives you 15% off if you'd like to try again later.` + sign
        : B('confirm first order, delivery within 90 days, no earlier guarantee refund and no chargeback, then refund the product price (not shipping) in shopify and cancel the subscription in loop') + `Hi ${name},\n\nThank you for letting me know, and I'm sorry InnaDerm didn't work for you. That's exactly what our 90-day money-back guarantee is for.\n\nI've refunded the product price of your order ${ord}, [AMOUNT], and cancelled your subscription so nothing else is charged. You're welcome to keep what's left. ${timeline}` + sign,
      R9: B('cancel the subscription in loop and check it shows cancelled') + `Hi ${name},\n\nDone: I've cancelled your subscription, so you won't be charged or sent anything else. If you'd rather pause it instead, just reply and I'll switch it for you.` + sign,
      R10: B('refund the renewal in full in shopify and cancel the subscription in loop') + `Hi ${name},\n\nI'm sorry: you asked us to cancel before this renewal and it went through anyway. That's our mistake. I've refunded the renewal in full ([AMOUNT]) and cancelled your subscription, and you're welcome to keep the product. ${timeline}` + sign,
      R11: B('cancel the subscription in loop') + `Hi ${name},\n\nI've cancelled your subscription so you won't be charged again. I'm sorry about the renewal: our policy is that renewals can be cancelled any time up to 48 hours before the billing date, and once a renewal has been processed it isn't refundable. You're welcome to keep the product, and ${code} gives you 15% off if you'd like to come back later.` + sign,
      R12: `Hi ${name},\n\nI'm sorry for the frustration, and thank you for coming to us first. [ANSWER THEIR ISSUE USING THE ROW THAT APPLIES.] We resolve most issues within 1-2 business days, and I'd much rather sort this out with you directly than through your bank, because a dispute closes the money-back guarantee on the order.` + sign,
      R13: '',
      R14: B('check the duplicate charge in shopify and refund it') + `Hi ${name},\n\nThank you for flagging this, and I'm sorry. You were charged twice for ${ord}, and I've refunded the extra charge of [AMOUNT] in full. ${timeline}` + sign,
      R15: `Hi ${name},\n\nThank you for letting us know. I've put order ${ord} on hold so nothing ships, and I've passed it to our founder to look into today. I'll come back to you by [DAY].` + sign,
      R16: `Hi ${name},\n\n[FIX THE ADDRESS IF UNSHIPPED, OR EXPLAIN.] ` + sign,
      R17: '',
    }
    return T[row] || ''
  }

  window.InnRefund = { STATUS, POLICY, ROWS, ALWAYS_CALVIN, DECISIONS, LIMIT, assess }
})()
