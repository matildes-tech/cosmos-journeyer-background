/*  The subpages.
 *
 *  They share the homepage's stylesheet, so the bar, the sheet and the closing
 *  panel are defined in exactly one place and cannot drift apart from the
 *  homepage's. What they do not share is the flight: nothing here creates an
 *  engine, so a subpage is a document that paints immediately.
 */
import "@styles/background.css";
import "@styles/pages.css";

// The bar fades in on `ready`, which on the homepage is the loader letting go.
// Here there is nothing to wait for.
document.body.classList.add("ready");

const navToggle = document.getElementById("navtoggle");
const closeNav = (): void => {
    document.body.classList.remove("nav-open");
    navToggle?.setAttribute("aria-expanded", "false");
};
navToggle?.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
});
for (const link of Array.from(document.querySelectorAll<HTMLElement>("#navsheet a"))) {
    link.addEventListener("click", closeNav);
}
document.getElementById("navsheet-scrim")?.addEventListener("click", closeNav);

/*  Same as the homepage: the field has nothing behind it yet, and navigating
    away on submit is a worse answer than saying nothing happened.  */
const newsletter = document.getElementById("endcard-form") as HTMLFormElement | null;
newsletter?.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = newsletter.querySelector("button");
    if (button !== null) button.textContent = "Thanks";
});
