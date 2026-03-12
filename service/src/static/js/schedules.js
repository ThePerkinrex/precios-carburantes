const DAYS = {
	L: 1, // lunes
	M: 2,
	X: 3,
	J: 4,
	V: 5,
	S: 6,
	D: 0, // domingo
};

function splitFirst(s, sep, limit = 2) {
	let res = []
	for(let i = 1;i<limit;i++) {
		let index = s.indexOf(sep)
		if (index == -1) break;
		res.push(s.substring(0, index))
		s = s.substring(index+1)
	}
	if(s.length > 0) res.push(s)
	return res
}

export function parseSchedule(text) {
	try {
		const parts = text.split(";").map((p) => p.trim());
		const schedule = {};

		for (let part of parts) {
			const [daysPart, timePart] = splitFirst(part, ":", 2).map((x) => x.trim());

			// console.log(daysPart, timePart)

			if (!daysPart || !timePart) return { valid: false };

			 

			const [startDay, endDay] = (daysPart.includes('-')) ? daysPart.split("-") : [daysPart, daysPart];

			// console.log(startDay, endDay)

			if (
				!DAYS.hasOwnProperty(startDay) ||
				!DAYS.hasOwnProperty(endDay)
			) {
				return { valid: false };
			}

			const startIndex = DAYS[startDay];
			const endIndex = DAYS[endDay];

			let timeData;

			if (timePart === "24H") {
				timeData = { open: "00:00", close: "23:59", fullDay: true };
			} else {
				const match = timePart.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
				if (!match) return { valid: false };

				timeData = {
					open: match[1],
					close: match[2],
					fullDay: false,
				};
			}

			let d = startIndex;
			while (true) {
				schedule[d] = timeData;

				if (d === endIndex) break;
				d = (d + 1) % 7;
			}
		}

		return { valid: true, schedule };
	} catch {
		return { valid: false };
	}
}

function toMinutes(time) {
	const [h, m] = time.split(":").map(Number);
	return h * 60 + m;
}

function minutesToDate(baseDate, dayOffset, minutes) {
	const d = new Date(baseDate);
	d.setDate(d.getDate() + dayOffset);
	d.setHours(0, 0, 0, 0);
	d.setMinutes(minutes);
	return d;
}

export function getStatus(scheduleText, date, soonMinutes = 30) {
	const parsed = parseSchedule(scheduleText);
	if (!parsed.valid) return { status: "invalid_format" };

	const day = date.getDay();
	const minutes = date.getHours() * 60 + date.getMinutes();

	const today = parsed.schedule[day];

	if (today) {
		if (today.fullDay) {
			return {
				status: "open",
				nextClose: minutesToDate(date, 1, 0)
			};
		}

		const open = toMinutes(today.open);
		const close = toMinutes(today.close);

		if (minutes < open) {
			const nextOpen = minutesToDate(date, 0, open);

			return {
				status: open - minutes <= soonMinutes ? "opensSoon" : "closed",
				nextOpen
			};
		}

		if (minutes <= close) {
			const nextClose = minutesToDate(date, 0, close);

			return {
				status: close - minutes <= soonMinutes ? "closesSoon" : "open",
				nextClose
			};
		}
	}

	// Buscar próximo día de apertura (wrap semanal)
	for (let i = 1; i <= 7; i++) {
		const d = (day + i) % 7;
		const sched = parsed.schedule[d];

		if (!sched) continue;

		if (sched.fullDay) {
			return {
				status: "closed",
				nextOpen: minutesToDate(date, i, 0)
			};
		}

		return {
			status: "closed",
			nextOpen: minutesToDate(date, i, toMinutes(sched.open))
		};
	}

	return { status: "closed" };
}

export function formatOpenCloseDate(targetDate, now = new Date()) {
	const time = targetDate.toLocaleTimeString("es-ES", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
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

	const date = targetDate.toLocaleDateString("es-ES");

	return `${date} - ${time}`;
}

