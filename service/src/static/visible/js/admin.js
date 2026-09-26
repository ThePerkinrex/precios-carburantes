import {
	adminCancelInvite,
	adminCreateInvite,
	adminListInvites,
	adminListUsers,
	adminRevokeCert,
} from "./api.js";
import { certRow, formatDate } from "./certs_ui.js";

function showError(element, e) {
	element.textContent = e.message;
	element.className = "error";
}

async function loadInvites() {
	const rows = document.getElementById("inviteRows");
	const invites = await adminListInvites();
	rows.replaceChildren(
		...invites.map((invite) => {
			const tr = document.createElement("tr");
			for (const text of [invite.cn, invite.label, invite.created_by, formatDate(invite.expires_at)]) {
				const td = document.createElement("td");
				td.textContent = text;
				tr.append(td);
			}
			const action = document.createElement("td");
			const button = document.createElement("button");
			button.className = "danger";
			button.textContent = "Cancel";
			button.addEventListener("click", async () => {
				await adminCancelInvite(invite.id);
				await loadInvites();
			});
			action.append(button);
			tr.append(action);
			return tr;
		}),
	);
}

async function loadUsers() {
	const container = document.getElementById("users");
	const message = document.getElementById("usersMessage");
	message.textContent = "";
	try {
		const users = await adminListUsers();
		document
			.getElementById("knownUsers")
			.replaceChildren(...users.map((u) => Object.assign(document.createElement("option"), { value: u.cn })));

		container.replaceChildren(
			...users.map((user) => {
				const div = document.createElement("div");
				div.className = "user";

				const heading = document.createElement("h3");
				heading.textContent = user.cn;
				for (const role of user.roles) {
					const tag = document.createElement("span");
					tag.className = "tag";
					tag.textContent = role;
					heading.append(tag);
				}

				const table = document.createElement("table");
				table.innerHTML =
					"<thead><tr><th>Device</th><th>Status</th><th>Expires</th><th>Serial</th><th></th></tr></thead>";
				const body = document.createElement("tbody");
				body.append(
					...user.certs.map((cert) =>
						certRow(cert, {
							onRevoke: async () => {
								if (!confirm(`Revoke ${user.cn}'s "${cert.label}" certificate? This can't be undone.`)) return;
								try {
									await adminRevokeCert(cert.serial, "cessation_of_operation");
									await loadUsers();
								} catch (e) {
									showError(message, e);
								}
							},
						}),
					),
				);
				table.append(body);

				const wrap = document.createElement("div");
				wrap.className = "table-wrap";
				wrap.append(table);
				div.append(heading, wrap);
				return div;
			}),
		);
	} catch (e) {
		showError(message, e);
	}
}

function setupInviteForm() {
	const form = document.getElementById("inviteForm");
	const message = document.getElementById("inviteMessage");
	const result = document.getElementById("inviteResult");
	const url = document.getElementById("inviteUrl");

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		message.textContent = "";
		result.hidden = true;
		try {
			const invite = await adminCreateInvite(form.cn.value, form.label.value, form.admin.checked);
			url.value = invite.url;
			result.hidden = false;
			message.textContent = `Link for ${form.cn.value} (${form.label.value}), valid until ${new Date(invite.expires_at * 1000).toLocaleString()}. It won't be shown again.`;
			message.className = "";
			form.reset();
			await loadInvites();
		} catch (e) {
			showError(message, e);
		}
	});

	document.getElementById("copyInvite").addEventListener("click", async () => {
		await navigator.clipboard.writeText(url.value);
	});
}

setupInviteForm();
loadInvites();
loadUsers();
