import { SignedXml } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";
import { deflateSync } from "fflate";
import { __name, error, nowIso, randomHex, cookieValue } from "./utils.js";
import { signToken, verifyToken, upsertUserAndIssueToken, sessionCookieHeader, SAML_REAUTH_COOKIE } from "./auth.js";
import idpMetadataXml from "../saml/idp-metadata.xml";

var enc = new TextEncoder();
var DEFAULT_SP_BASE_URL = "https://ai.ntpu.edu.tw";
var REQUEST_COOKIE = "ntpu_ai_saml_req";
var REQUEST_MAX_AGE = 300;
var CLOCK_SKEW_SECONDS = 60;
// 資訊中心尚未回覆確切屬性名稱前，依常見命名逐一嘗試；回覆後可用 SAML_EMAIL_ATTRIBUTE 直接指定。
var EMAIL_ATTRIBUTE_CANDIDATES = [
  "mail",
  "email",
  "eduPersonPrincipalName",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "urn:oid:1.3.6.1.4.1.5923.1.1.1.6"
];
var selectWithNs = xpath.useNamespaces({
  md: "urn:oasis:names:tc:SAML:2.0:metadata",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion"
});
var REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
var SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
var BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
var idpConfigCache = null;
var idpConfigCacheSource = null;

// 正式網址定案前，SP 網址可用 SAML_SP_BASE_URL 覆寫；本機測試時設成 http://localhost:8787。
function spUrls(env) {
  const base = String(env.SAML_SP_BASE_URL || DEFAULT_SP_BASE_URL).trim().replace(/\/$/, "");
  // 資中 IdP 已用 /saml/metadata 登記本站（2026-09），改了就要請資中重新登記；/auth/saml/metadata 也提供同一份 metadata。
  return { entityId: `${base}/saml/metadata`, acsUrl: `${base}/auth/saml/acs` };
}
__name(spUrls, "spUrls");

// SAML_IDP_METADATA_XML 只給本機測試換成假 IdP 用（.dev.vars），正式環境不要設。
function idpConfig(env) {
  const source = String(env.SAML_IDP_METADATA_XML || "").trim() || idpMetadataXml;
  if (idpConfigCache && idpConfigCacheSource === source) return idpConfigCache;
  const doc = new DOMParser().parseFromString(source, "text/xml");
  const idp = "//md:EntityDescriptor/md:IDPSSODescriptor";
  const entityId = selectWithNs("string(//md:EntityDescriptor[md:IDPSSODescriptor]/@entityID)", doc);
  // AuthnRequest 是用 HTTP-Redirect 送出的，所以優先用這個 binding 的網址。
  const ssoUrl = selectWithNs(`string(${idp}/md:SingleSignOnService[@Binding='${REDIRECT_BINDING}']/@Location)`, doc)
    || selectWithNs(`string(${idp}/md:SingleSignOnService/@Location)`, doc);
  const certs = selectWithNs(`${idp}/md:KeyDescriptor[not(@use) or @use='signing']//ds:X509Certificate`, doc).map((node) => node.textContent.replace(/\s+/g, ""));
  if (!entityId || !ssoUrl || certs.length === 0) throw new Error("IdP metadata 不完整（缺 entityID / SSO URL / 簽章憑證）");
  idpConfigCache = { entityId, ssoUrl, certs };
  idpConfigCacheSource = source;
  return idpConfigCache;
}
__name(idpConfig, "idpConfig");

function certPem(base64Cert) {
  const lines = base64Cert.match(/.{1,64}/g) || [base64Cert];
  return `-----BEGIN CERTIFICATE-----
${lines.join("\n")}
-----END CERTIFICATE-----`;
}
__name(certPem, "certPem");

function stdBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
__name(stdBase64, "stdBase64");

function pemToDer(pem) {
  const body = String(pem).replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}
__name(pemToDer, "pemToDer");

async function signRequestQuery(query, env) {
  const privateKeyPem = String(env.SAML_SP_PRIVATE_KEY || "").trim();
  if (!privateKeyPem) return query;
  const sigAlg = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const signable = `${query}&SigAlg=${encodeURIComponent(sigAlg)}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signable));
  return `${signable}&Signature=${encodeURIComponent(stdBase64(new Uint8Array(signature)))}`;
}
__name(signRequestQuery, "signRequestQuery");

function safeRelativePath(path) {
  // 瀏覽器會把 /\evil.com 當成 //evil.com（外站），所以反斜線與控制字元一律不收。
  return /^\/(?![\/\\])[^\\\s\x00-\x1f\x7f]*$/.test(String(path || "")) ? path : "/";
}
__name(safeRelativePath, "safeRelativePath");

async function buildLoginRedirect(env, relayPath, forceAuthn) {
  const { ssoUrl } = idpConfig(env);
  const { entityId: spEntityId, acsUrl } = spUrls(env);
  const requestId = `_${randomHex(16)}`;
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${nowIso()}"${forceAuthn ? ' ForceAuthn="true"' : ""} Destination="${ssoUrl}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${spEntityId}</saml:Issuer><samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:transient" AllowCreate="true"/></samlp:AuthnRequest>`;
  const samlRequest = stdBase64(deflateSync(enc.encode(xml)));
  const relayState = safeRelativePath(relayPath);
  let query = `SAMLRequest=${encodeURIComponent(samlRequest)}&RelayState=${encodeURIComponent(relayState)}`;
  query = await signRequestQuery(query, env);
  const requestToken = await signToken({ rid: requestId, exp: Math.floor(Date.now() / 1e3) + REQUEST_MAX_AGE }, env.AUTH_SECRET);
  // IdP 以跨站 POST 回到 ACS，SameSite=Lax 的 cookie 不會被帶上，因此這個一次性 cookie 必須用 None。
  return {
    redirectUrl: `${ssoUrl}?${query}`,
    cookie: `${REQUEST_COOKIE}=${encodeURIComponent(requestToken)}; Path=/; Max-Age=${REQUEST_MAX_AGE}; HttpOnly; Secure; SameSite=None`
  };
}
__name(buildLoginRedirect, "buildLoginRedirect");

export async function loginWithSaml(request, env) {
  try {
    const url = new URL(request.url);
    const forceAuthn = cookieValue(request, SAML_REAUTH_COOKIE) === "1";
    const { redirectUrl, cookie } = await buildLoginRedirect(env, url.searchParams.get("redirect"), forceAuthn);
    return new Response(null, {
      status: 302,
      headers: { location: redirectUrl, "cache-control": "no-store", "set-cookie": cookie }
    });
  } catch (cause) {
    console.error("SAML 登入初始化失敗", cause);
    return error("SAML 登入初始化失敗，請稍後再試", 500);
  }
}
__name(loginWithSaml, "loginWithSaml");

function withinValidity(notBefore, notOnOrAfter) {
  const now = Date.now();
  if (notBefore && now < new Date(notBefore).getTime() - CLOCK_SKEW_SECONDS * 1e3) return false;
  if (notOnOrAfter && now > new Date(notOnOrAfter).getTime() + CLOCK_SKEW_SECONDS * 1e3) return false;
  return true;
}
__name(withinValidity, "withinValidity");

function verifyAssertionSignature(fullXml, signatureNode, expectedIdAttr, certs) {
  const referenceNode = xpath.select(".//*[local-name(.)='Reference']", signatureNode)[0];
  const referenceUri = referenceNode?.getAttribute("URI") || "";
  if (referenceUri !== `#${expectedIdAttr}`) throw new Error("簽章 Reference 與預期的元素 ID 不一致");
  // xml-crypto 驗證失敗時會直接拋例外；資中換憑證期間 metadata 會同時列新舊兩張，所以要逐張試完再判定失敗。
  let lastError = null;
  for (const cert of certs) {
    try {
      const sig = new SignedXml({ publicCert: certPem(cert) });
      sig.loadSignature(signatureNode);
      if (sig.checkSignature(fullXml)) return true;
    } catch (cause) {
      lastError = cause;
    }
  }
  if (lastError) console.error("SAML 簽章驗證失敗", lastError.message);
  return false;
}
__name(verifyAssertionSignature, "verifyAssertionSignature");

function extractAttributes(assertionNode) {
  const attrs = {};
  const nodes = selectWithNs(".//saml:AttributeStatement/saml:Attribute", assertionNode);
  for (const node of nodes) {
    const name = node.getAttribute("Name");
    if (!name) continue;
    // 一定要用 textContent：text() 會被注入的 <!----> 拆成兩段，而簽章不涵蓋註解，攻擊者就能把信箱截短冒充別人。
    const values = selectWithNs("./saml:AttributeValue", node).map((n) => n.textContent.trim()).filter(Boolean);
    if (values.length) attrs[name] = values;
  }
  return attrs;
}
__name(extractAttributes, "extractAttributes");

function pickEmail(attrs, env) {
  const override = String(env.SAML_EMAIL_ATTRIBUTE || "").trim();
  const candidates = override ? [override, ...EMAIL_ATTRIBUTE_CANDIDATES] : EMAIL_ATTRIBUTE_CANDIDATES;
  for (const name of candidates) {
    const value = (attrs[name] || []).find((v) => v.includes("@"));
    if (value) return value.trim().toLowerCase();
  }
  return "";
}
__name(pickEmail, "pickEmail");

// 資中寫的是 edupersonAffiliation（標準是 eduPersonAffiliation），屬性名稱不分大小寫比對，也接受 OID 形式。
function attrValues(attrs, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const [name, values] of Object.entries(attrs)) {
    if (wanted.includes(name.toLowerCase())) return values;
  }
  return [];
}
__name(attrValues, "attrValues");

function pickProfile(attrs) {
  const displayName = (attrValues(attrs, ["displayName", "urn:oid:2.16.840.1.113730.3.1.241"])[0] || "").slice(0, 100);
  // 身分可能有多個值（例如同時是 teacher 與 staff），全部保留；值範例：staff / teacher / student。
  const affiliation = [...new Set(
    attrValues(attrs, ["eduPersonAffiliation", "urn:oid:1.3.6.1.4.1.5923.1.1.1.1"])
      .map((v) => v.toLowerCase())
      .filter((v) => /^[a-z-]{1,32}$/.test(v))
  )];
  return { displayName, affiliation };
}
__name(pickProfile, "pickProfile");

export async function handleAcs(request, env) {
  try {
    const form = await request.formData();
    const samlResponseB64 = String(form.get("SAMLResponse") || "");
    if (!samlResponseB64) return error("缺少 SAMLResponse", 400);
    const target = safeRelativePath(form.get("RelayState"));

    const reqCookieToken = cookieValue(request, REQUEST_COOKIE);
    if (!reqCookieToken) return error("登入已過期，請重新登入", 400);
    const { rid: expectedRequestId } = await verifyToken(reqCookieToken, env.AUTH_SECRET);

    const xml = new TextDecoder().decode(Uint8Array.from(atob(samlResponseB64), (c) => c.charCodeAt(0)));
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const { entityId: idpEntityId, certs } = idpConfig(env);
    const { entityId: spEntityId, acsUrl } = spUrls(env);

    const responseNode = doc.documentElement;
    if (!responseNode || responseNode.namespaceURI !== SAMLP_NS || responseNode.localName !== "Response") return error("無法識別 SAML 回應格式", 400);

    const statusValue = selectWithNs("string(./samlp:Status/samlp:StatusCode/@Value)", responseNode);
    if (statusValue !== "urn:oasis:names:tc:SAML:2.0:status:Success") {
      console.error("SAML IdP 回報失敗狀態", statusValue);
      return error("校院登入服務回報失敗，請重新登入或聯系管理員", 403);
    }

    // 只接受由本站發起的登入（SP-initiated），不收 IdP 主動送來、沒有 InResponseTo 的回應。
    if (responseNode.getAttribute("InResponseTo") !== expectedRequestId) return error("登入請求不匹配，請重新登入", 400);
    const destination = responseNode.getAttribute("Destination");
    if (destination && destination !== acsUrl) return error("登入憑證不適用於本服務", 403);

    const responseIssuer = selectWithNs("string(./saml:Issuer/text())", responseNode);
    if (responseIssuer && responseIssuer !== idpEntityId) return error("發行方不一致", 403);

    const assertionNodes = selectWithNs("./saml:Assertion", responseNode);
    if (assertionNodes.length !== 1) return error("SAML 回應中的 Assertion 數量異常", 403);
    const assertionNode = assertionNodes[0];
    const assertionId = assertionNode.getAttribute("ID") || "";
    const assertionIssuer = selectWithNs("string(./saml:Issuer/text())", assertionNode);
    if (assertionIssuer !== idpEntityId) return error("Assertion 發行方不一致", 403);

    const responseSig = selectWithNs("./ds:Signature", responseNode)[0];
    const assertionSig = selectWithNs("./ds:Signature", assertionNode)[0];
    if (!responseSig && !assertionSig) return error("SAML 回應未簽章，拒絕登入", 403);
    const fullXml = xml;
    let signatureOk = false;
    if (assertionSig) signatureOk = verifyAssertionSignature(fullXml, assertionSig, assertionId, certs);
    if (!signatureOk && responseSig) {
      const responseId = responseNode.getAttribute("ID") || "";
      signatureOk = verifyAssertionSignature(fullXml, responseSig, responseId, certs);
    }
    if (!signatureOk) return error("SAML 簽章驗證失敗，拒絕登入", 403);

    const conditionsNode = selectWithNs("./saml:Conditions", assertionNode)[0];
    if (!conditionsNode) return error("登入憑證不適用於本服務", 403);
    if (!withinValidity(conditionsNode.getAttribute("NotBefore"), conditionsNode.getAttribute("NotOnOrAfter"))) {
      return error("登入憑證已過期，請重新登入", 403);
    }
    const audiences = selectWithNs("./saml:AudienceRestriction/saml:Audience", conditionsNode).map((n) => n.textContent.trim());
    if (!audiences.includes(spEntityId)) return error("登入憑證不適用於本服務", 403);

    // Web SSO profile 規定要檢查 bearer SubjectConfirmation：必須是送給本站 ACS、回應本次請求、而且還沒過期。
    const confirmed = selectWithNs(`./saml:Subject/saml:SubjectConfirmation[@Method='${BEARER}']/saml:SubjectConfirmationData`, assertionNode).some((node) => {
      const confirmationInResponseTo = node.getAttribute("InResponseTo");
      return node.getAttribute("Recipient") === acsUrl
        && (!confirmationInResponseTo || confirmationInResponseTo === expectedRequestId)
        && withinValidity(node.getAttribute("NotBefore"), node.getAttribute("NotOnOrAfter"));
    });
    if (!confirmed) return error("登入憑證不適用於本服務", 403);

    const attrs = extractAttributes(assertionNode);
    const email = pickEmail(attrs, env);
    if (!email) {
      console.error("SAML 回應中找不到信箱屬性，可用屬性名稱：", Object.keys(attrs));
      return error("登入成功但無法取得信箱，請聯系系統管理員", 403);
    }
    // 帳號驗證完全交給學校 IdP：簽章通過就放行，以 IdP 送來的 mail 當帳號，不再檢查信箱網域。
    const profile = pickProfile(attrs);
    // mail 可能是使用者能自行修改的聯絡信箱：不讓 SAML 登入接手 ADMIN_EMAIL 這個舊的管理員帳號。
    if (email === String(env.ADMIN_EMAIL || "").toLowerCase()) {
      console.warn("SAML 登入的信箱與 ADMIN_EMAIL 相同，已拒絕");
      return error("此信箱無法透過學校 SSO 登入，請聯絡系統管理員", 403);
    }

    const { token } = await upsertUserAndIssueToken(email, env, profile);
    const headers = new Headers({ location: target, "cache-control": "no-store" });
    headers.append("set-cookie", sessionCookieHeader(token));
    headers.append("set-cookie", `${REQUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`);
    headers.append("set-cookie", `${SAML_REAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  } catch (cause) {
    console.error("SAML ACS 處理失敗", cause);
    return error("SAML 登入失敗，請重新登入", 403);
  }
}
__name(handleAcs, "handleAcs");

export function spMetadataXml(env) {
  const signed = Boolean(String(env.SAML_SP_PRIVATE_KEY || "").trim());
  const { entityId, acsUrl } = spUrls(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:SPSSODescriptor AuthnRequestsSigned="${signed}" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}
__name(spMetadataXml, "spMetadataXml");

export function handleSpMetadata(env) {
  return new Response(spMetadataXml(env), { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" } });
}
__name(handleSpMetadata, "handleSpMetadata");
