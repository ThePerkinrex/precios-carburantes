// Translations. The English text is the key: pages and scripts are written
// in English, and `t` swaps in the Spanish from lang/es.js when lang.js
// picked Spanish. A string missing from es.js shows in English.

import ES from "./lang/es.js";

export const LANG = document.documentElement.lang === "es" ? "es" : "en";
// For toLocaleString and friends.
export const LOCALE = LANG === "es" ? "es-ES" : "en-GB";

const DICT = LANG === "es" ? ES : {};

// t("Signed in as {name}", { name }) -> "Sesión iniciada como ana"
export function t(text, params = {}) {
	const translated = DICT[text] ?? text;
	return translated.replace(/\{(\w+)\}/g, (match, key) => (key in params ? params[key] : match));
}

// t with a count: `one` when n is 1, `other` otherwise, with {n} filled in.
export function tn(n, one, other, params = {}) {
	return t(n === 1 ? one : other, { n, ...params });
}

const ATTRIBUTES = ["title", "placeholder", "aria-label", "alt"];
const normalize = (text) => text.trim().replace(/\s+/g, " ");

// Translates the static text of `root`: every text node and the
// ATTRIBUTES that match a key in the dictionary, plus the page title.
export function translatePage(root = document) {
	if (LANG === "en") return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) =>
			node.parentElement?.closest("script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const key = normalize(node.data);
		if (!key || !(key in DICT)) continue;
		// Keep the surrounding whitespace, which separates it from its siblings.
		const [, before, after] = /^(\s*)[\s\S]*?(\s*)$/.exec(node.data);
		node.data = before + DICT[key] + after;
	}
	const elements = root.querySelectorAll?.(ATTRIBUTES.map((a) => `[${a}]`).join(",")) ?? [];
	for (const el of elements) {
		for (const attr of ATTRIBUTES) {
			const key = el.getAttribute(attr);
			if (key && normalize(key) in DICT) el.setAttribute(attr, DICT[normalize(key)]);
		}
	}
}

translatePage();
