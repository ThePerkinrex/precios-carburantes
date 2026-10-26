// Euro amounts other than pump prices (changes, differences, tax cuts) go
// through here: "0.20 €", or "0,20 €" in Spanish.

import { LOCALE } from "./i18n.js";

// 0.2 -> "0.20 €", with up to `max` decimals when the amount has them
// ("0.114 €"). `signed` adds a "+" to positive amounts.
export function formatEuros(euros, { signed = false, max = 3 } = {}) {
	const text = `${Math.abs(euros).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: max })} €`;
	if (euros < 0) return `−${text}`;
	return signed && euros > 0 ? `+${text}` : text;
}
