const supportedLocales = new Set(["zh-CN", "en", "ja"]);

export async function loadI18n() {
  const configResponse = await fetch("./theme-config.json");
  if (!configResponse.ok) throw new Error(`theme-config.json: ${configResponse.status}`);
  const config = await configResponse.json();
  const language = supportedLocales.has(config.locale) ? config.locale : "zh-CN";
  const messagesResponse = await fetch(`./locales/${language}.json`);
  if (!messagesResponse.ok) throw new Error(`locales/${language}.json: ${messagesResponse.status}`);
  const messages = await messagesResponse.json();
  const locale = language === "ja" ? "ja-JP" : language === "en" ? "en-US" : "zh-CN";

  function t(key, parameters = {}) {
    const template = typeof messages[key] === "string" ? messages[key] : key;
    return template.replace(/\{(\w+)\}/g, (match, name) => parameters[name] === undefined ? match : String(parameters[name]));
  }

  document.documentElement.lang = language;
  return { language, locale, t };
}
