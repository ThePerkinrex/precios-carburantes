let logos = undefined;

export async function getLogos() {
	if (logos === undefined) {
		logos = await fetch("/files/data/logos.json").then((x) => x.json());
	}
	return logos;
}
