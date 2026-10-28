// The stations the user saved or hid everywhere, shared by the map, the
// route pages, "My stations" and the dashboard. Changes show at once and are
// undone if the server refuses them.

import { deleteMyStation, getMyStations, putMyStation } from "./api.js";

export class MyStations {
	// `records`: what getMyStations returns.
	constructor(records = []) {
		this.byId = new Map(records.map((r) => [r.id, r]));
		this.listeners = new Set();
	}

	// Never fails: a page still works without the lists.
	static async load() {
		try {
			return new MyStations(await getMyStations());
		} catch (e) {
			console.error("Couldn't load your stations", e);
			return new MyStations();
		}
	}

	// handler(id, record or undefined) after every change, and again if it's undone.
	on(handler) {
		this.listeners.add(handler);
	}

	off(handler) {
		this.listeners.delete(handler);
	}

	#emit(id) {
		for (const handler of this.listeners) handler(id, this.byId.get(id));
	}

	get(id) {
		return this.byId.get(id);
	}

	isSaved(id) {
		return this.byId.get(id)?.kind === "saved";
	}

	isHidden(id) {
		return this.byId.get(id)?.kind === "hidden";
	}

	nickname(id) {
		return this.isSaved(id) ? (this.byId.get(id).nickname ?? null) : null;
	}

	ids(kind) {
		return [...this.byId.values()].filter((r) => r.kind === kind).map((r) => r.id);
	}

	// Applies `next` (a record, or undefined to forget it) now, and sends
	// `request`; on failure puts the old record back and rethrows.
	async #change(id, next, request) {
		const before = this.byId.get(id);
		if (next) this.byId.set(id, next);
		else this.byId.delete(id);
		this.#emit(id);
		try {
			await request();
		} catch (e) {
			if (before) this.byId.set(id, before);
			else this.byId.delete(id);
			this.#emit(id);
			throw e;
		}
	}

	// `eess`: the station's record, kept so lists can show it right away.
	save(eess, nickname = this.nickname(eess.id)) {
		const next = { ...this.#base(eess), kind: "saved", nickname: nickname?.trim() || null };
		return this.#change(eess.id, next, () => putMyStation(eess.id, "saved", next.nickname));
	}

	hide(eess) {
		const next = { ...this.#base(eess), kind: "hidden", nickname: null };
		return this.#change(eess.id, next, () => putMyStation(eess.id, "hidden"));
	}

	rename(id, nickname) {
		return this.save(this.byId.get(id), nickname);
	}

	remove(id) {
		return this.#change(id, undefined, () => deleteMyStation(id));
	}

	#base(eess) {
		const old = this.byId.get(eess.id);
		const kept = old ?? { created_at: Math.floor(Date.now() / 1000), en_listado: true };
		return { ...kept, ...eess, created_at: kept.created_at };
	}
}
