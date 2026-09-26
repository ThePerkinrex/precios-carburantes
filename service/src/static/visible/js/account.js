import { getMyCerts, getUserState, renewMyCert, revokeMyCert } from "./api.js";
import { certRow, expiryWarning, formatDate } from "./certs_ui.js";

let state;

async function loadCerts() {
	const rows = document.getElementById("certRows");
	const message = document.getElementById("certsMessage");
	message.textContent = "";
	try {
		const certs = await getMyCerts();
		rows.replaceChildren(
			...certs.map((cert) =>
				certRow(cert, {
					note: cert.current ? "this device" : null,
					onRevoke: async () => {
						const warning = cert.current
							? "This is the certificate you're using right now. After revoking it, this device loses access until you get a new one from an admin.\n\n"
							: "";
						if (!confirm(`${warning}Revoke "${cert.label}"? This can't be undone.`)) return;
						try {
							await revokeMyCert(cert.serial);
							await loadCerts();
						} catch (e) {
							message.textContent = e.message;
							message.className = "error";
						}
					},
				}),
			),
		);
	} catch (e) {
		message.textContent = e.message;
		message.className = "error";
	}
}

async function load() {
	state = await getUserState();
	const current = document.getElementById("currentCert");
	const form = document.getElementById("renewForm");

	if (!state.cert) {
		current.textContent = "Not using a client certificate (development mode).";
		document.getElementById("renewSection").hidden = true;
	} else {
		current.textContent = `Signed in as ${state.username} with "${state.cert.label}", valid until ${formatDate(state.cert.not_after)}.`;
		form.label.value = state.cert.label;

		const warning = expiryWarning(state.cert.not_after);
		if (warning) {
			const banner = document.getElementById("expiryBanner");
			banner.textContent = `${warning} Renew it below.`;
			banner.hidden = false;
		}
	}

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const message = document.getElementById("renewMessage");
		const button = form.querySelector("button");
		button.disabled = true;
		message.textContent = "";
		try {
			const name = await renewMyCert(form.password.value, form.password2.value, form.label.value);
			message.textContent = `Downloaded ${name}. Open it to import it on this device, then restart the browser.`;
			message.className = "";
			form.reset();
			form.label.value = state.cert.label;
			await loadCerts();
		} catch (e) {
			message.textContent = e.message;
			message.className = "error";
		} finally {
			button.disabled = false;
		}
	});

	await loadCerts();
}

load();
