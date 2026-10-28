// A Chart.js x axis over timestamps (ms), so points are spaced by time and
// missing data shows as a gap. Chart.js's own time scale needs a date
// adapter; this is a linear scale with ticks on whole hours, days, months or
// years instead.

import { formatDayMonth, formatMonthYear } from "./dates.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Roughly how long each unit is, to pick the step.
const UNIT_MS = { hour: HOUR_MS, day: DAY_MS, month: 30.44 * DAY_MS, year: 365.25 * DAY_MS };
// [unit, step], finest first. 7 days start on Monday.
const STEPS = [
	["hour", 1], ["hour", 3], ["hour", 6], ["hour", 12],
	["day", 1], ["day", 2], ["day", 7],
	["month", 1], ["month", 3], ["month", 6],
	["year", 1], ["year", 2], ["year", 5], ["year", 10],
];
// Room each tick label needs, in pixels.
const TICK_WIDTH = 56;

// The start of the step `t` (local time) falls in.
function floorTo(t, unit, step) {
	const d = new Date(t);
	if (unit === "hour") {
		d.setMinutes(0, 0, 0);
		d.setHours(d.getHours() - (d.getHours() % step));
		return d;
	}
	d.setHours(0, 0, 0, 0);
	if (unit === "day") {
		if (step === 7) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
		return d;
	}
	d.setDate(1);
	if (unit === "month") {
		d.setMonth(d.getMonth() - (d.getMonth() % step));
		return d;
	}
	d.setMonth(0);
	d.setFullYear(d.getFullYear() - (d.getFullYear() % step));
	return d;
}

function advance(d, unit, step) {
	if (unit === "hour") d.setHours(d.getHours() + step);
	else if (unit === "day") d.setDate(d.getDate() + step);
	else if (unit === "month") d.setMonth(d.getMonth() + step);
	else d.setFullYear(d.getFullYear() + step);
}

const LABELS = {
	hour: (d) => `${formatDayMonth(d)} ${String(d.getHours()).padStart(2, "0")}:00`,
	day: formatDayMonth,
	month: formatMonthYear,
	year: (d) => String(d.getFullYear()),
};

// The x scale options. `min` and `max` (ms) fix the window, so a stretch
// without data at either end shows too; `ticks` is merged into the tick
// options.
export function timeAxis({ min, max, ticks = {}, ...rest } = {}) {
	let unit = "day";
	return {
		type: "linear",
		bounds: "data",
		min,
		max,
		...rest,
		afterBuildTicks(scale) {
			const span = scale.max - scale.min;
			const most = Math.max(2, Math.floor(scale.width / TICK_WIDTH));
			let step;
			[unit, step] = STEPS.find(([u, s]) => span / (UNIT_MS[u] * s) <= most) ?? STEPS.at(-1);
			const d = floorTo(scale.min, unit, step);
			if (d.getTime() < scale.min) advance(d, unit, step);
			const values = [];
			for (; d.getTime() <= scale.max; advance(d, unit, step)) values.push({ value: d.getTime() });
			scale.ticks = values;
		},
		ticks: {
			maxRotation: 0,
			...ticks,
			callback: (value) => LABELS[unit](new Date(value)),
		},
	};
}

// A line's `segment` option: hides the stretch between two points more than
// `maxGap` ms apart, so the line breaks where data is missing instead of
// joining across it.
export const gapSegment = (maxGap) => ({
	borderColor: (ctx) => (ctx.p1.parsed.x - ctx.p0.parsed.x > maxGap ? "transparent" : undefined),
});
