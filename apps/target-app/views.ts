import type { Member } from "./state.js";

/**
 * Deliberately hostile markup, modelled on real legacy back-office screens:
 *   - frameset shell (nav + content), so scoping actually matters
 *   - table-based layout, no CSS grid, no semantic sectioning
 *   - NO test ids, NO stable element ids on the interesting controls
 *   - class names that carry no meaning (`x1`, `tdl`, `c3`)
 *   - incidental wrapper depth that changes between renders
 *
 * What IS stable: <label for> relationships, table header cells, and heading text.
 * That is exactly the metadata semantic targeting relies on, and the reason a
 * positional selector breaks here while role+name+anchor survives.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let renderCounter = 0;

/** Wraps content in a varying number of meaningless divs - incidental structure drift. */
function jitterWrap(html: string): string {
  renderCounter += 1;
  const depth = (renderCounter % 3) + 1;
  let out = html;
  for (let i = 0; i < depth; i++) {
    out = `<div class="x${i}">${out}</div>`;
  }
  return out;
}

function page(title: string, body: string): string {
  return `<html><head><title>${esc(title)}</title></head>
<body class="bg">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="tdl">
${body}
</td></tr></table>
</body></html>`;
}

export function frameset(): string {
  return `<html><head><title>CoreBank Teller</title></head>
<frameset cols="180,*">
  <frame name="nav" src="/teller/nav">
  <frame name="content" src="/teller/search">
</frameset>
</html>`;
}

export function nav(): string {
  return page(
    "Navigation",
    `<table cellpadding="2" cellspacing="0" border="0">
  <tr><td class="c3"><a href="/teller/search" target="content">Member Search</a></td></tr>
  <tr><td class="c3"><a href="/teller/search" target="content">Account Servicing</a></td></tr>
</table>`,
  );
}

export function searchForm(error?: string): string {
  const alert = error
    ? `<table class="err" cellpadding="2" cellspacing="0" border="0"><tr>
         <td class="c3"><span class="errmsg" role="alert">${esc(error)}</span></td></tr></table>`
    : "";
  return page(
    "CoreBank Teller - Member Search",
    `<h2>Member Search</h2>
${alert}
${jitterWrap(`<form method="post" action="/teller/search">
  <table cellpadding="3" cellspacing="0" border="0">
    <tr>
      <td class="tdl"><label for="f_mid">Member ID</label></td>
      <td class="c3"><input type="text" id="f_mid" name="memberId" size="12"></td>
    </tr>
    <tr><td colspan="2"><input type="submit" value="Search"></td></tr>
  </table>
</form>`)}`,
  );
}

export function searchResults(members: readonly Member[], notice?: string): string {
  if (notice) {
    return page(
      "CoreBank Teller - Search Results",
      `<h2>Search Results</h2>
<table cellpadding="2" cellspacing="0" border="0"><tr>
  <td class="c3"><span class="notice">${esc(notice)}</span></td></tr></table>
<hr>
${searchFormFragment()}`,
    );
  }
  const rows = members
    .map(
      (m) => `  <tr>
    <td class="c3"><a href="/teller/member/${esc(m.id)}">${esc(m.id)}</a></td>
    <td class="c3">${esc(m.name)}</td>
    <td class="c3">Active</td>
  </tr>`,
    )
    .join("\n");
  return page(
    "CoreBank Teller - Search Results",
    `<h2>Search Results</h2>
${jitterWrap(`<table cellpadding="3" cellspacing="1" border="1">
  <tr><th>Member</th><th>Name</th><th>Status</th></tr>
${rows}
</table>`)}`,
  );
}

function searchFormFragment(): string {
  return `<h2>Member Search</h2>
<form method="post" action="/teller/search">
  <table cellpadding="3" cellspacing="0" border="0">
    <tr>
      <td class="tdl"><label for="f_mid2">Member ID</label></td>
      <td class="c3"><input type="text" id="f_mid2" name="memberId" size="12"></td>
    </tr>
    <tr><td colspan="2"><input type="submit" value="Search"></td></tr>
  </table>
</form>`;
}

export function memberDetail(m: Member): string {
  const rows = m.accounts
    .map(
      (a) => `  <tr>
    <td class="c3">${esc(a.type)}</td>
    <td class="c3">${esc(a.number)}</td>
    <td class="c3">${esc(a.balance)}</td>
    <td class="c3">Open</td>
  </tr>`,
    )
    .join("\n");
  return page(
    "CoreBank Teller - Member Detail",
    `<h2>Member Detail</h2>
${jitterWrap(`<h3>Member: ${esc(m.name)}</h3>
<table cellpadding="2" cellspacing="0" border="0">
  <tr><td class="tdl">Member ID</td><td class="c3">${esc(m.id)}</td></tr>
</table>`)}
<h2>Accounts</h2>
<table cellpadding="3" cellspacing="1" border="1">
  <tr><th>Account Type</th><th>Account</th><th>Current Balance</th><th>Status</th></tr>
${rows}
</table>`,
  );
}

export function signOn(): string {
  return page(
    "CoreBank Teller - Sign On",
    `<h2>Session Expired</h2>
${jitterWrap(`<form method="post" action="/teller/signon">
  <table cellpadding="3" cellspacing="0" border="0">
    <tr><td class="tdl"><label for="f_uid">User ID</label></td>
        <td class="c3"><input type="text" id="f_uid" name="username" size="16"></td></tr>
    <tr><td class="tdl"><label for="f_pwd">Password</label></td>
        <td class="c3"><input type="password" id="f_pwd" name="password" size="16"></td></tr>
    <tr><td colspan="2"><input type="submit" value="Sign On"></td></tr>
  </table>
</form>`)}`,
  );
}

export function interstitial(): string {
  return page(
    "CoreBank Teller - System Notice",
    `<h2>System Notice</h2>
<table cellpadding="4" cellspacing="0" border="1"><tr><td class="c3">
  <span class="notice">Scheduled maintenance window begins at 22:00 ET.</span><br><br>
  <form method="post" action="/teller/acknowledge">
    <input type="submit" value="Acknowledge">
  </form>
</td></tr></table>`,
  );
}

export function permissionDenied(): string {
  return page(
    "CoreBank Teller - Access Denied",
    `<h2>Access Denied</h2>
<table cellpadding="2" cellspacing="0" border="0"><tr><td class="c3">
  <span class="errmsg" role="alert">You are not authorized to view this member.</span>
</td></tr></table>`,
  );
}

export function appError(): string {
  return page(
    "CoreBank Teller - Error",
    `<h2>Unexpected system error</h2>
<table cellpadding="2" cellspacing="0" border="0"><tr><td class="c3">
  <span class="errmsg">Reference MSG-5521. Contact the service desk.</span>
</td></tr></table>`,
  );
}
