// ThriftBooks has no link that adds a copy to the cart. Its own site does a
// POST to /api/cart/addtocart with the copy's inventory id (idiq); the two GET
// routes in its bundle are a 404 and a "save to list" page. A form posted
// from our site would not carry the shopper's cookies (SameSite=Lax), so it
// would start a new session and swap their cart for an empty one.
//
// So the cart link is the ThriftBooks cart page with the copies in the hash,
// and a bookmarklet the shopper installs once does the POSTs from inside
// thriftbooks.com, where the cookies are first-party.

export const THRIFTBOOKS_CART_PAGE = 'https://www.thriftbooks.com/shopping-cart/'
const HASH_KEY = 'earmarked'

export function thriftBooksCartLink(idIq: number | string, quantity = 1): string {
  return `${THRIFTBOOKS_CART_PAGE}#${HASH_KEY}=${idIq}:${quantity}`
}

export function isThriftBooksCartLink(url: string): boolean {
  return url.startsWith(`${THRIFTBOOKS_CART_PAGE}#${HASH_KEY}=`)
}

/** idiq → quantity, summed across links (one link per copy comes in). */
function parseCopies(urls: string[]): Map<string, number> {
  const copies = new Map<string, number>()
  for (const url of urls) {
    const m = new RegExp(`${HASH_KEY}=([\\d:,]+)`).exec(url)
    if (!m) continue
    for (const part of m[1].split(',')) {
      const [idIq, qty] = part.split(':')
      if (!idIq) continue
      copies.set(idIq, (copies.get(idIq) ?? 0) + (Number(qty) || 1))
    }
  }
  return copies
}

/**
 * Collapse ThriftBooks cart links into one (a single tab, a single bookmarklet
 * click) and pass every other link through unchanged, order preserved.
 */
export function mergeThriftBooksCartLinks(urls: string[]): string[] {
  const tb = urls.filter(isThriftBooksCartLink)
  if (tb.length === 0) return urls
  const copies = parseCopies(tb)
  const merged = `${THRIFTBOOKS_CART_PAGE}#${HASH_KEY}=${[...copies].map(([id, q]) => `${id}:${q}`).join(',')}`
  const out: string[] = []
  let placed = false
  for (const url of urls) {
    if (!isThriftBooksCartLink(url)) { out.push(url); continue }
    if (!placed) { out.push(merged); placed = true }
  }
  return out
}

/**
 * Drag-to-bookmarks-bar script. On the ThriftBooks cart page it reads the
 * copies from the hash, adds each through ThriftBooks' own cart call, then
 * reloads so the cart shows them. Anywhere else it explains what to do.
 */
export const THRIFTBOOKS_BOOKMARKLET = 'javascript:' + encodeURIComponent(`void(async()=>{
const m=/${HASH_KEY}=([\\d:,]+)/.exec(location.hash);
if(location.hostname!=='www.thriftbooks.com'||!m){alert('Open the ThriftBooks cart page from Earmarked first (the "Add to cart on ThriftBooks" button), then click this bookmark there.');return}
const q={};for(const p of m[1].split(',')){const[i,n]=p.split(':');if(i)q[i]=(q[i]||0)+(Number(n)||1)}
const bad=[];
for(const i in q){try{
const r=await fetch('/api/cart/addtocart',{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({idiq:i,quantity:String(q[i]),getCart:'true',referringUrl:location.origin+'/shopping-cart/'})});
const j=await r.json().catch(()=>null);if(!r.ok||!j||j.Error)bad.push(i)}catch(e){bad.push(i)}}
const n=Object.keys(q).length;
if(bad.length)alert(bad.length+' of '+n+' could not be added — probably sold out since the search. The rest are in your cart.');
history.replaceState(null,'',location.pathname);location.reload()})()`.replace(/\n/g, ''))
