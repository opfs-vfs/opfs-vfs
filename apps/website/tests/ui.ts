import { expect, type Page } from '@playwright/test';

export async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(trigger).toContainText(option);
}

export async function continueDialog(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
}

// `Locator.fill` selects the old text through the DOM. An editor transaction that lands before the browser
// reports that selection, such as the language finishing loading, resets it, and the new text is inserted in front
// of the old. The editor's own select-all keeps the selection in its state.
export async function fillEditor(page: Page, label: string, text: string) {
  await page.getByLabel(label).press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}
