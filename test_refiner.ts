import { refineUserPrompt } from "./src/pipeline/promptRefiner";

async function main() {
    const p1 = "why even when i am asking for modality of images in my textual prompt its till always providing the images?fix that";
    const p2 = "why even when i am asking for modality of videos in my textual prompt its till always providing the images?fix that";
    const p3 = "make a video of a photorealistic dog";

    console.log("P1:", await refineUserPrompt(p1));
    console.log("P2:", await refineUserPrompt(p2));
    console.log("P3:", await refineUserPrompt(p3));
}

main().catch(console.error);
