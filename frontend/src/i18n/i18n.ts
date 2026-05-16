import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import he from "./he.json";
import ar from "./ar.json";
import ru from "./ru.json";
import de from "./de.json";
import fr from "./fr.json";

export const SUPPORTED_LANGS = [
  { code: "en", label: "English",  flag: "🇬🇧", rtl: false },
  { code: "he", label: "עברית",    flag: "🇮🇱", rtl: true  },
  { code: "ar", label: "العربية",  flag: "🇸🇦", rtl: true  },
  { code: "ru", label: "Русский",  flag: "🇷🇺", rtl: false },
  { code: "de", label: "Deutsch",  flag: "🇩🇪", rtl: false },
  { code: "fr", label: "Français", flag: "🇫🇷", rtl: false },
] as const;

export type LangCode = typeof SUPPORTED_LANGS[number]["code"];

const LS_KEY = "solarica.lang";
const VALID = new Set<string>(SUPPORTED_LANGS.map((l) => l.code));

function detect(): LangCode {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && VALID.has(saved)) return saved as LangCode;
  } catch { /* ignore */ }
  // Fall back to the browser locale when it is one of the supported set,
  // otherwise default to English — we do NOT auto-pick Hebrew/Arabic from
  // the browser since English is the baseline product language.
  if (typeof navigator !== "undefined") {
    const code = (navigator.language || "en").slice(0, 2).toLowerCase();
    if (VALID.has(code)) return code as LangCode;
  }
  return "en";
}

export function applyDirection(code: string) {
  const lang = SUPPORTED_LANGS.find((l) => l.code === code);
  const dir = lang?.rtl ? "rtl" : "ltr";
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", code);
    document.documentElement.setAttribute("dir", dir);
  }
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    he: { translation: he },
    ar: { translation: ar },
    ru: { translation: ru },
    de: { translation: de },
    fr: { translation: fr },
  },
  lng: detect(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

applyDirection(i18n.language);

i18n.on("languageChanged", (lng) => {
  try { localStorage.setItem(LS_KEY, lng); } catch { /* ignore */ }
  applyDirection(lng);
});

export default i18n;
