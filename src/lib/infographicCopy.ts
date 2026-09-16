/** The title and body of the delete-infographic dialog. */
export interface DeleteInfographicCopy {
  title: string;
  body: string;
}

/**
 * The copy for the delete-infographic dialog: a title naming it, and a body
 * warning the action can't be undone.
 *
 * Kept as a pure function, the same way deckFolders.ts's own
 * deleteFolderModalCopy is — so the wording is checked here
 * (tools/test-infographic.mjs) rather than only ever seen in the browser.
 */
export function deleteInfographicModalCopy(title: string): DeleteInfographicCopy {
  return {
    title: `Delete "${title}"?`,
    body: "This can't be undone.",
  };
}
