import { formatDate } from "./dates.js";

const DAYS = {
	L: 1, // lunes
	M: 2,
	X: 3,
	J: 4,
	V: 5,
	S: 6,
	D: 0, // domingo
};

const DAY_MINUTES = 24 * 60;

// "7:00" / "07:00" -> minutes since midnight. "23:59" counts as midnight, so
// "00:00-23:59" is a whole day and back-to-back days join up.
function parseTime(text) {
	const match = text.match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	if (minutes > DAY_MINUTES) return null;
	return minutes === DAY_MINUTES - 1 ? DAY_MINUTES : minutes;
}

// "06:00-14:00" -> [start, end] in minutes; an end at or before the start
// ("22:00-06:00", "06:00-00:00") runs past midnight into the next day.
function parseWindow(text) {
	if (text === "24H") return [0, DAY_MINUTES];
	const [open, close] = text.split("-").map((t) => parseTime(t.trim()));
	if (open == null || close == null) return null;
	return [open, close <= open ? close + DAY_MINUTES : close];
}

/**
 * Parses the Ministry's schedule text, e.g.
 *   "L-D: 24H", "L-V: 07:00-22:00; S: 08:00-14:00",
 *   "L-S: 08:00-14:00 y 16:00-20:00"
 * into { valid, schedule, mondayOnly }, where schedule[day] (0 = Sunday)
 * is a list of [start, end] windows in minutes from that day's midnight.
 *
 * mondayOnly: the text only lists Monday ("L: ..."). About 4% of stations
 * say that, with ordinary all-week hours, across every brand and province:
 * it's almost certainly a data-entry mistake for "every day".
 */
export function parseSchedule(text) {
	if (typeof text !== "string") return { valid: false };
	const schedule = {};

	for (const part of text.split(";").map((p) => p.trim()).filter(Boolean)) {
		const colon = part.indexOf(":");
		if (colon === -1) return { valid: false };
		const daysPart = part.substring(0, colon).trim();
		const timePart = part.substring(colon + 1).trim();

		const [startDay, endDay = startDay] = daysPart.split("-").map((d) => d.trim());
		if (!(startDay in DAYS) || !(endDay in DAYS)) return { valid: false };

		const windows = timePart.split(/\s+y\s+/).map(parseWindow);
		if (!windows.length || windows.some((w) => w == null)) return { valid: false };

		for (let d = DAYS[startDay]; ; d = (d + 1) % 7) {
			schedule[d] = [...(schedule[d] ?? []), ...windows];
			if (d === DAYS[endDay]) break;
		}
	}

	const days = Object.keys(schedule);
	if (!days.length) return { valid: false };
	return { valid: true, schedule, mondayOnly: days.length === 1 && days[0] === "1" };
}

function minutesToDate(baseDate, minutesFromMidnight) {
	const d = new Date(baseDate);
	d.setHours(0, 0, 0, 0);
	d.setMinutes(minutesFromMidnight);
	return d;
}

/**
 * Whether a station is open at `date`:
 *   { status: "open" | "closesSoon" | "closed" | "opensSoon" | "invalid_format",
 *     nextOpen?: Date, nextClose?: Date | null (null: open around the clock),
 *     uncertain?: true (Monday-only schedule applied to another day) }
 */
export function getStatus(scheduleText, date, soonMinutes = 30) {
	const parsed = parseSchedule(scheduleText);
	if (!parsed.valid) return { status: "invalid_format" };

	const day = date.getDay();
	const now = date.getHours() * 60 + date.getMinutes();

	// A Monday-only schedule most likely means those hours every day.
	const uncertain = parsed.mondayOnly && day !== 1;
	const windowsOn = (d) => (parsed.mondayOnly ? parsed.schedule[1] : parsed.schedule[d]) ?? [];

	// Every window from yesterday (it may run past midnight) to a week ahead,
	// in minutes from today's midnight, merged where they touch.
	const intervals = [];
	for (let offset = -1; offset <= 7; offset++) {
		for (const [start, end] of windowsOn((day + offset + 7) % 7)) {
			intervals.push([offset * DAY_MINUTES + start, offset * DAY_MINUTES + end]);
		}
	}
	intervals.sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const interval of intervals) {
		const last = merged[merged.length - 1];
		if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
		else merged.push([...interval]);
	}

	const extra = uncertain ? { uncertain: true } : {};
	const current = merged.find(([start, end]) => start <= now && now < end);
	if (current) {
		// Open through the whole week we looked at: around the clock.
		if (current[1] >= 7 * DAY_MINUTES) return { status: "open", nextClose: null, ...extra };
		const nextClose = minutesToDate(date, current[1]);
		return { status: current[1] - now <= soonMinutes ? "closesSoon" : "open", nextClose, ...extra };
	}

	const next = merged.find(([start]) => start > now);
	if (!next) return { status: "closed", ...extra };
	return {
		status: next[0] - now <= soonMinutes ? "opensSoon" : "closed",
		nextOpen: minutesToDate(date, next[0]),
		...extra,
	};
}

export function formatOpenCloseDate(targetDate, now = new Date()) {
	const time = targetDate.toLocaleTimeString("es-ES", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const today = new Date(now);
	today.setHours(0, 0, 0, 0);

	const tomorrow = new Date(today);
	tomorrow.setDate(tomorrow.getDate() + 1);

	const targetDay = new Date(targetDate);
	targetDay.setHours(0, 0, 0, 0);

	if (targetDay.getTime() === today.getTime()) {
		return `Hoy - ${time}`;
	}

	if (targetDay.getTime() === tomorrow.getTime()) {
		return `Mañana - ${time}`;
	}

	const date = formatDate(targetDate);

	return `${date} - ${time}`;
}
