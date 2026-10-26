// Settings: the UI language and the car profile the route planner uses.

import { getUserState, updateCar, updateLanguage } from "./api.js";
import { DEFAULT_CAR } from "./car.js";
import { t, useLanguage } from "./i18n.js";
import { renderNav } from "./nav.js";

const languageGroup = document.getElementById("language");
const languageMessage = document.getElementById("languageMessage");
const carForm = document.getElementById("carForm");
const carMessage = document.getElementById("carMessage");

// The number fields, named as in the API's car, and their defaults.
const CAR_FIELDS = {
	consumption: DEFAULT_CAR.consumption,
	tank_size: DEFAULT_CAR.tankSize,
	stop_min: DEFAULT_CAR.stopMin,
	stop_max: DEFAULT_CAR.stopMax,
};

let state;

function showLanguage() {
	const value = state.language ?? "";
	for (const input of languageGroup.querySelectorAll("input")) input.checked = input.value === value;
}

// Unset fields show the planner's default as a placeholder and stay unset.
function showCar() {
	const car = state.car;
	for (const input of carForm.querySelectorAll('input[name="fuel"]')) {
		input.checked = input.value === (car.fuel ?? DEFAULT_CAR.fuel);
	}
	for (const [name, fallback] of Object.entries(CAR_FIELDS)) {
		const input = carForm.elements[name];
		input.value = car[name] ?? "";
		input.placeholder = fallback;
	}
}

function readCar() {
	const number = (name) => (carForm.elements[name].value === "" ? null : Number(carForm.elements[name].value));
	return {
		fuel: carForm.elements.fuel.value || null,
		...Object.fromEntries(Object.keys(CAR_FIELDS).map((name) => [name, number(name)])),
	};
}

// The planner's rules, with defaults standing in for unset fields.
function carProblem(car) {
	const value = (name) => car[name] ?? CAR_FIELDS[name];
	if (value("stop_min") >= value("tank_size")) return t("The minimum has to be below the tank size.");
	if (value("stop_min") > value("stop_max")) return t("The maximum can't be below the minimum.");
	return null;
}

languageGroup.addEventListener("change", async (event) => {
	const language = event.target.value || null;
	languageMessage.textContent = "";
	try {
		await updateLanguage(language);
		state.language = language;
		// Reloads the page if it's now in another language.
		useLanguage(language);
		languageMessage.textContent = t("Saved.");
	} catch (err) {
		languageMessage.textContent = err.message;
		showLanguage();
	}
});

carForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const car = readCar();
	const problem = carProblem(car);
	if (problem) {
		carMessage.textContent = problem;
		return;
	}
	carMessage.textContent = "";
	try {
		await updateCar(car);
		state.car = car;
		carMessage.textContent = t("Saved.");
	} catch (err) {
		carMessage.textContent = err.message;
	}
});

state = await getUserState();
renderNav(document.getElementById("nav"), state, "settings");
showLanguage();
showCar();
