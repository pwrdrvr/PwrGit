/** The disclosure caret on the sidebar's ref sections and their sub-groups. */
export function SectionChevron({ open }: { open: boolean }) {
  return <span className={`ref-section__chev${open ? " is-open" : ""}`} />;
}
