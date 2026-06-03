export const renderPromptTemplate = (
  templateName: string,
  template: string,
  variables: Record<string, string>,
): string =>
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for template ${templateName}`);
    }

    return variables[key] ?? "";
  });
