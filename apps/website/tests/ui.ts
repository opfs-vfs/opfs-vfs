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
