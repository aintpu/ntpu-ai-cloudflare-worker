-- 校園 SSO 回傳的姓名與身分（displayName / edupersonAffiliation），每次 SAML 登入時更新。
-- affiliation 以逗號分隔，可能同時有多個值，例如 "staff,teacher"。
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN affiliation TEXT NOT NULL DEFAULT '';
