// 本機 SAML ACS 測試：用假 IdP（test/saml-fixture）簽發 SAMLResponse，打 wrangler dev 驗證 src/saml.js 的各種防護。
// 用法：終端機 1 跑 `npx wrangler dev`（需要 .dev.vars），終端機 2 跑 `node test/saml-acs.test.mjs`。
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import xmlCrypto from "xml-crypto";

const { SignedXml } = xmlCrypto;
const BASE_URL = (process.env.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const SP_METADATA_URL = `${BASE_URL}/auth/saml/metadata`;
const ACS_URL = `${BASE_URL}/auth/saml/acs`;
const IDP_ENTITY_ID = "https://fake-idp.test/metadata";
const IDP_KEY = readFileSync(new URL("./saml-fixture/fake-idp-key.pem", import.meta.url), "utf8");
const ATTACKER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const ADMIN_EMAIL = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").match(/ADMIN_EMAIL = "([^"]+)"/)[1];
// 學校 IdP 實際是用 OID 當屬性名稱送出（2026-09-30 wrangler tail 觀察到的）。
const OID_NAMES = { mail: "urn:oid:0.9.2342.19200300.100.1.3", displayName: "urn:oid:2.16.840.1.113730.3.1.241", affiliation: "urn:oid:1.3.6.1.4.1.5923.1.1.1.1" };
const FRIENDLY_NAMES = { mail: "mail", displayName: "displayName", affiliation: "edupersonAffiliation" };
const NS = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';

const SP_METADATA = await fetch(SP_METADATA_URL).then((r) => r.text()).catch(() => "");
const SP_ENTITY_ID = SP_METADATA.match(/entityID="([^"]+)"/)?.[1] || "";
if (!SP_ENTITY_ID) throw new Error(`讀不到 ${SP_METADATA_URL}，wrangler dev 有啟動嗎？`);

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1e3).toISOString();
const newId = () => `_${randomBytes(16).toString("hex")}`;

async function startLogin(relay = "/after-login", extraCookie = "") {
  const res = await fetch(`${BASE_URL}/auth/saml/login?redirect=${encodeURIComponent(relay)}`, { redirect: "manual", headers: extraCookie ? { cookie: extraCookie } : {} });
  if (res.status !== 302) throw new Error(`/auth/saml/login 回傳 ${res.status}，wrangler dev 有啟動嗎？.dev.vars 有設嗎？`);
  const location = new URL(res.headers.get("location"));
  const requestXml = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest"), "base64")).toString("utf8");
  const requestId = requestXml.match(/\sID="([^"]+)"/)[1];
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ntpu_ai_saml_req=")).split(";")[0];
  return { requestId, cookie, relay: location.searchParams.get("RelayState"), forceAuthn: requestXml.includes('ForceAuthn="true"') };
}

function assertionXml(o) {
  const n = o.oidNames ? OID_NAMES : FRIENDLY_NAMES;
  const conditions = o.noConditions ? "" : `<saml:Conditions NotBefore="${o.notBefore}" NotOnOrAfter="${o.notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`;
  return `<saml:Assertion ID="${o.assertionId}" Version="2.0" IssueInstant="${iso()}"><saml:Issuer>${o.issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">${newId()}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${o.notOnOrAfter}" Recipient="${o.recipient}"${o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : ""}/></saml:SubjectConfirmation></saml:Subject>${conditions}<saml:AuthnStatement AuthnInstant="${iso()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="${n.mail}">${[].concat(o.email).map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("")}</saml:Attribute><saml:Attribute Name="${n.displayName}"><saml:AttributeValue>${o.displayName}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="${n.affiliation}">${o.affiliation.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("")}</saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
}

function signAssertion(xml, privateKey) {
  const sig = new SignedXml({ privateKey });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"]
  });
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" }
  });
  return sig.getSignedXml();
}

// 產生一份 SAMLResponse；overrides 用來製造各種錯誤情境。
function buildResponse(login, overrides = {}) {
  const o = {
    email: "tester@gm.ntpu.edu.tw",
    displayName: "王大明",
    affiliation: ["teacher", "staff"],
    issuer: IDP_ENTITY_ID,
    audience: SP_ENTITY_ID,
    inResponseTo: login.requestId,
    destination: ACS_URL,
    recipient: ACS_URL,
    notBefore: iso(-60),
    notOnOrAfter: iso(300),
    assertionId: newId(),
    signingKey: IDP_KEY,
    ...overrides
  };
  const assertion = assertionXml(o);
  const wrapped = `<samlp:Response ${NS} ID="${newId()}" Version="2.0" IssueInstant="${iso()}" Destination="${o.destination}"${o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : ""}><saml:Issuer>${o.issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  return o.signingKey ? signAssertion(wrapped, o.signingKey) : wrapped;
}

async function postAcs(xml, { cookie, relay = "/after-login" } = {}) {
  const body = new URLSearchParams({ SAMLResponse: Buffer.from(xml, "utf8").toString("base64"), RelayState: relay });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(ACS_URL, { method: "POST", body, headers, redirect: "manual" });
  const text = await res.text();
  let detail = "";
  try { detail = JSON.parse(text).detail || ""; } catch {}
  return { status: res.status, location: res.headers.get("location"), setCookies: res.headers.getSetCookie(), detail };
}

async function me(r) {
  const session = r.setCookies.find((c) => c.startsWith("ntpu_ai_session=") && !c.startsWith("ntpu_ai_session=;"));
  if (!session) return null;
  const res = await fetch(`${BASE_URL}/me`, { headers: { cookie: session.split(";")[0] } });
  return res.ok ? res.json() : null;
}

const cases = [
  {
    name: "登出後再登入會要求學校重新輸入帳密（ForceAuthn），登入成功後恢復正常",
    async run() {
      const out = await fetch(`${BASE_URL}/auth/logout`, { method: "POST" });
      const reauth = out.headers.getSetCookie().find((c) => c.startsWith("ntpu_ai_saml_reauth=1"));
      const normal = await startLogin();
      const afterLogout = await startLogin("/after-login", reauth ? reauth.split(";")[0] : "");
      const r = await postAcs(buildResponse(afterLogout), { cookie: `${afterLogout.cookie}; ${reauth?.split(";")[0] || ""}` });
      const cleared = r.setCookies.some((c) => c.startsWith("ntpu_ai_saml_reauth=;"));
      r.detail = `登出設標記=${!!reauth} 平常ForceAuthn=${normal.forceAuthn} 登出後ForceAuthn=${afterLogout.forceAuthn} 登入後清除=${cleared}`;
      return { ok: !!reauth && !normal.forceAuthn && afterLogout.forceAuthn && r.status === 302 && cleared, r };
    }
  },
  {
    name: "用瀏覽器直接打開 ACS（GET）回 405，而不是 404",
    async run() {
      const res = await fetch(ACS_URL, { redirect: "manual" });
      const r = { status: res.status, detail: (await res.json().catch(() => ({}))).detail || "" };
      return { ok: res.status === 405 && res.headers.get("allow") === "POST", r };
    }
  },
  {
    name: "SP metadata 的 entityID 網址打得開，而且內容就是這份 metadata",
    async run() {
      const res = await fetch(SP_ENTITY_ID.replace(/^https:\/\/ai\.ntpu\.edu\.tw/, BASE_URL));
      const body = await res.text();
      const r = { status: res.status, detail: SP_ENTITY_ID };
      return { ok: res.ok && body.includes(`entityID="${SP_ENTITY_ID}"`), r };
    }
  },
  {
    name: "正常登入（校內信箱、正確簽章），/me 回傳姓名與身分",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login), login);
      const user = await me(r);
      r.detail = user ? `${user.display_name} ${user.email} [${user.affiliation}]` : "拿不到 /me";
      const ok = r.status === 302 && r.location === "/after-login" && user?.display_name === "王大明" && user.affiliation.join(",") === "teacher,staff";
      return { ok, r };
    }
  },
  {
    name: "再次登入時身分會更新（例如老師改成只有 student）",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { displayName: "王小明", affiliation: ["student"] }), login);
      const user = await me(r);
      r.detail = user ? `${user.display_name} [${user.affiliation}]` : "拿不到 /me";
      return { ok: r.status === 302 && user?.display_name === "王小明" && user.affiliation.join(",") === "student", r };
    }
  },
  {
    name: "簽章後竄改信箱",
    async run() {
      const login = await startLogin();
      const xml = buildResponse(login).replace("tester@gm.ntpu.edu.tw", "attacker@gm.ntpu.edu.tw");
      const r = await postAcs(xml, login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "完全沒有簽章",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { signingKey: null }), login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "用別把私鑰簽章（冒充 IdP）",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { signingKey: ATTACKER_KEY }), login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "InResponseTo 對不上",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { inResponseTo: newId() }), login);
      return { ok: r.status === 400, r };
    }
  },
  {
    name: "Assertion 已過期",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { notBefore: iso(-3600), notOnOrAfter: iso(-600) }), login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "Audience 不是本服務",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { audience: "https://other-sp.example/metadata" }), login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "和學校 IdP 實際送的格式一樣（OID 屬性名稱），學校 Gmail → 可以登入，而且不是管理員",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { oidNames: true, email: "s411234567@gm.ntpu.edu.tw", displayName: "陳同學", affiliation: ["student"] }), login);
      const user = await me(r);
      if (user) r.detail = `${user.display_name} ${user.email} [${user.affiliation}] admin=${user.admin}`;
      return { ok: r.status === 302 && user?.email === "s411234567@gm.ntpu.edu.tw" && user.admin === false, r };
    }
  },
  {
    name: "IdP 的 mail 是個人 Gmail → 照樣登入（帳號驗證交給學校，不檢查網域）",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { oidNames: true, email: "someone@gmail.com", affiliation: ["student"] }), login);
      const user = await me(r);
      if (user) r.detail = `登入成為 ${user.email} admin=${user.admin}`;
      return { ok: r.status === 302 && user?.email === "someone@gmail.com" && user.admin === false, r };
    }
  },
  {
    name: "IdP 的 mail 被改成管理員的 Gmail（ADMIN_EMAIL）→ 拒絕，不能用 SAML 進管理員帳號",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { email: ADMIN_EMAIL, affiliation: ["student"] }), login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "沒有登入請求 cookie",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login), { cookie: "" });
      return { ok: r.status === 400, r };
    }
  },
  {
    name: "簽章包裝攻擊（XSW：合法 Assertion 藏起來，換上偽造的）",
    async run() {
      const login = await startLogin();
      const signed = buildResponse(login);
      const original = signed.match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)[0];
      const assertionId = original.match(/ID="([^"]+)"/)[1];
      const signature = original.match(/<Signature[\s\S]*<\/Signature>/)[0];
      const evil = assertionXml({
        email: "attacker@gm.ntpu.edu.tw", displayName: "攻擊者", affiliation: ["teacher"], issuer: IDP_ENTITY_ID, audience: SP_ENTITY_ID, inResponseTo: login.requestId,
        notBefore: iso(-60), notOnOrAfter: iso(300), assertionId
      }).replace(`</saml:Issuer>`, `</saml:Issuer>${signature}`);
      const xml = signed.replace(original, `<samlp:Extensions>${original}</samlp:Extensions>${evil}`);
      const r = await postAcs(xml, login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "註解注入（在簽好的信箱中插入 <!----> 冒充別人）",
    async run() {
      const login = await startLogin();
      const xml = buildResponse(login, { email: "s411234567@gm.ntpu.edu.tw" }).replace(">s411234567@", ">s4<!---->11234567@");
      const r = await postAcs(xml, login);
      const user = await me(r);
      if (user) r.detail = `登入成為 ${user.email}`;
      return { ok: r.status === 403 || user?.email === "s411234567@gm.ntpu.edu.tw", r };
    }
  },
  {
    name: "登入後被導到外站（RelayState=/\\evil.example）",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login), { ...login, relay: "/\\evil.example" });
      return { ok: r.status === 302 && r.location === "/", r };
    }
  },
  {
    name: "沒有 InResponseTo（不是我們發起的登入）",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { inResponseTo: null }), login);
      return { ok: r.status === 400, r };
    }
  },
  {
    name: "Response 的 Destination 不是本服務",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { destination: "https://other-sp.example/acs" }), login);
      return { ok: r.status === 403, r };
    }
  },
  {
    name: "Assertion 的 Recipient 不是本服務",
    async run() {
      const login = await startLogin();
      const r = await postAcs(buildResponse(login, { recipient: "https://other-sp.example/acs" }), login);
      return { ok: r.status === 403, r };
    }
  }
];

let failed = 0;
for (const c of cases) {
  try {
    const { ok, r } = await c.run();
    if (!ok) failed++;
    console.log(`${ok ? "✅" : "❌"} ${c.name} → ${r.status}${r.detail ? ` ${r.detail}` : ""}${r.location ? ` → ${r.location}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${c.name} → 例外：${e.message}`);
  }
}
console.log(failed ? `\n${failed} 個案例失敗` : `\n全部 ${cases.length} 個案例通過`);
process.exit(failed ? 1 : 0);
