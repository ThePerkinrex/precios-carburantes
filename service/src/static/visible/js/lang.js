// Picks the UI language before the page renders: Spanish if the browser
// prefers it to English, English otherwise. Loaded as a classic script in
// <head> so a Spanish page never flashes its English source text; i18n.js
// (a module, so it runs before DOMContentLoaded) translates the page.
(() => {
	const root = document.documentElement;
	const languages = navigator.languages?.length ? navigator.languages : [navigator.language ?? "en"];
	const lang = languages.map((l) => l.toLowerCase().split("-")[0]).find((l) => l === "es" || l === "en") ?? "en";
	root.lang = lang;
	if (lang === "en") return;
	root.style.visibility = "hidden";
	document.addEventListener("DOMContentLoaded", () => {
		root.style.visibility = "";
	});
})();
