// The main process shares one dictionary with the renderer, so both sides say the same thing.
const shared = require('../ui/i18n.js');
let resolved = false;
function detect() {
  const chosen = process.env.LIBRIUM_LANG;
  if (chosen === 'ru' || chosen === 'en') return chosen;
  let locale = '';
  // app.getLocale() is only reliable after the ready event, so fall back to the Node locale.
  try { locale = require('electron').app.getLocale() || ''; } catch {}
  if (!locale) try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch {}
  return /^ru/i.test(locale) ? 'ru' : 'en';
}
function ensure() { if (!resolved) { resolved = true; shared.set(detect()); } return shared; }
module.exports = {
  t: (key, params) => ensure().t(key, params),
  set: lang => { resolved = true; return shared.set(lang); },
  get lang() { return ensure().lang; },
};
