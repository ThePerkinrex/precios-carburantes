// What the fuel planner assumes for anything the user hasn't set in their
// car profile (Settings, or the route options panel).

export const DEFAULT_CAR = {
	fuel: "diesel", // "diesel" | "gasolina"
	consumption: 6, // L/100km
	tankSize: 50, // L
	initialFuel: 40, // L currently in the tank
	stopMin: 5, // L — don't let the tank drop below this without a stop
	stopMax: 20, // L — happy to stop early if it's convenient and we're under this
};
