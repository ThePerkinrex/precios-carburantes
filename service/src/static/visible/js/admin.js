import {
	adminCancelInvite,
	adminCreateInvite,
	adminListInvites,
	adminListUsers,
	adminRevokeCert,
	getUserState,
} from "./api.js";
import { formatDateTime } from "./dates.js";
import { actionButton, certItem, certLists, fillList, formatDate, listItem, showError } from "./certs_ui.js";
import { t } from "./i18n.js";
import { renderNav } from "./nav.js";

async function loadInvites() {
	const list = document.getElementById("inviteList");
	const message = document.getElementById("invitesMessage");
	message.textContent = "";
	try {
		const invites = await adminListInvites();
		fillList(
			list,
			invites.map((invite) =>
				listItem({
					title: `${invite.cn} · ${invite.label}`,
					lines: [{ text: t("By {user}, expires {date}", { user: invite.created_by, date: formatDate(invite.expires_at) }) }],
					action: actionButton(t("Cancel"), async () => {
						try {
							await adminCancelInvite(invite.id);
							await loadInvites();
						} catch (e) {
							showError(message, e);
						}
					}),
				}),
			),
			t("No pending invites."),
		);
	} catch (e) {
		showError(message, e);
	}
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

				const item = (cert) =>
					certItem(cert, {
						onRevoke: async () => {
							if (!confirm(t("Revoke {user}'s \"{label}\" certificate? This can't be undone.", { user: user.cn, label: cert.label }))) return;
							try {
								await adminRevokeCert(cert.serial, "cessation_of_operation");
								await loadUsers();
							} catch (e) {
								showError(message, e);
							}
						},
					});

				div.append(heading, ...certLists(user.certs, item));
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
	const copy = document.getElementById("copyInvite");
	const share = document.getElementById("shareInvite");
	// The share sheet is the easy way to send the link on a phone.
	share.hidden = !navigator.share;

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const button = form.querySelector("button[type=submit]");
		button.disabled = true;
		message.textContent = "";
		result.hidden = true;
		try {
			const invite = await adminCreateInvite(form.cn.value, form.label.value, form.admin.checked);
			url.value = invite.url;
			copy.textContent = t("Copy");
			result.hidden = false;
			message.textContent = t("Link for {user} ({label}), valid until {date}. It won't be shown again.", {
				user: form.cn.value,
				label: form.label.value,
				date: formatDateTime(new Date(invite.expires_at * 1000)),
			});
			message.className = "";
			form.reset();
			await loadInvites();
		} catch (e) {
			showError(message, e);
		} finally {
			button.disabled = false;
		}
	});

	copy.addEventListener("click", async () => {
		await navigator.clipboard.writeText(url.value);
		copy.textContent = t("Copied");
	});

	share.addEventListener("click", async () => {
		try {
			await navigator.share({ title: t("Carburantes invite"), url: url.value });
		} catch {
			// Dismissed the share sheet.
		}
	});
}

getUserState().then((state) => renderNav(document.getElementById("nav"), state, "admin"));
setupInviteForm();
loadInvites();
loadUsers();
