// Every date shown in the app goes through here: dd/mm/yyyy and 24-hour
// times, whatever the browser's locale.

const pad = (n) => String(n).padStart(2, "0");

// Date -> "27/03/2026"
export function formatDate(date) {
	return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// Date -> "27/03/2026 09:27"
export function formatDateTime(date) {
	return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Unix seconds -> "27/03/2026"
export function formatUnixDate(unix) {
	return formatDate(new Date(unix * 1000));
}

// The API's "2026-03-27 09:27:26" (local time, no zone) -> Date
export function parseFecha(fecha) {
	return new Date(fecha.replace(" ", "T"));
}
