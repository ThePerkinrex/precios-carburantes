// Shared bits for the account and admin pages.

const DAY = 24 * 60 * 60;
export const RENEW_WARNING_DAYS = 30;

export function formatDate(unix) {
	return new Date(unix * 1000).toLocaleDateString();
}

// A message if a cert expiring at `notAfter` should be renewed soon, else null.
export function expiryWarning(notAfter) {
	const days = Math.floor((notAfter - Date.now() / 1000) / DAY);
	if (days > RENEW_WARNING_DAYS) return null;
	return days <= 0
		? "Your certificate for this device expires today."
		: `Your certificate for this device expires in ${days} day${days === 1 ? "" : "s"}.`;
}

function cell(text, className) {
	const td = document.createElement("td");
	td.textContent = text;
	if (className) td.className = className;
	return td;
}

// A <tr> for one cert: label, status, expiry, serial, revoke button.
export function certRow(cert, { note, onRevoke }) {
	const tr = document.createElement("tr");

	const label = cell(cert.label);
	if (note) {
		const tag = document.createElement("span");
		tag.className = "tag";
		tag.textContent = note;
		label.append(tag);
	}

	const status =
		cert.status === "revoked" ? `revoked ${formatDate(cert.revoked_at)}` : cert.status;

	const action = document.createElement("td");
	if (cert.status === "active") {
		const button = document.createElement("button");
		button.className = "danger";
		button.textContent = "Revoke";
		button.addEventListener("click", onRevoke);
		action.append(button);
	}

	tr.append(
		label,
		cell(status, `status-${cert.status}`),
		cell(formatDate(cert.not_after)),
		cell(cert.serial, "serial"),
		action,
	);
	return tr;
}
