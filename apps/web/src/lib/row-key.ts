/**
 * A unique key for a row in an editable list.
 *
 * ⚠️ THIS EXISTS BECAUSE `crypto.randomUUID()` IS NOT AVAILABLE HERE, AND THE
 *   FAILURE IS A HARD CRASH RATHER THAN A FALLBACK. It is a SECURE-CONTEXT API:
 *   the browser only defines it on HTTPS or on `localhost` itself. Development
 *   runs on `http://<slug>.lvh.me:3000` — a hostname that resolves to 127.0.0.1
 *   but is not `localhost` — so `crypto.randomUUID` is `undefined` there and the
 *   component throws `crypto.randomUUID is not a function` the moment it renders.
 *
 *   It works on the SERVER (Node defines it unconditionally), so a `useState`
 *   initialiser using it renders fine and then explodes on hydration. That is why
 *   it survived review: the page loads.
 *
 * ⚠️ AND A UUID WAS NEVER THE RIGHT TOOL. These keys are React `key` props on a
 *   list somebody is typing into. They never reach the API, are never stored, and
 *   need to be unique only within one form for one mount — which a counter gives
 *   with no entropy, no crypto and no platform dependency. Three forms already
 *   did exactly this with a private `let nextKey = 1`; this is that, once.
 *
 * NOT for anything that leaves the browser. An id the server will see comes from
 * the server, or from `uuid` on it.
 */
let counter = 0;

export function nextRowKey(): string {
  counter += 1;
  return `row-${String(counter)}`;
}
