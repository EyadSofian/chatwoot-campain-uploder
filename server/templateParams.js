export function normalizeTemplateVariableKey(value) {
  return String(value || '')
    .trim()
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
}

export function isTemplateVariableKey(value) {
  const key = normalizeTemplateVariableKey(value);
  return /^\d+$/.test(key) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function extractTemplateVariables(text) {
  const matches = String(text || '').match(/\{\{\s*[^}]+\s*\}\}/g) || [];
  return [...new Set(matches.map(normalizeTemplateVariableKey).filter(Boolean))];
}

export function parseParamMap(text) {
  const params = {};
  let lastKey = null;

  String(text || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (lastKey) params[lastKey] += '\n';
      return;
    }
    if (!lastKey && trimmed.startsWith('#')) return;

    const eq = trimmed.indexOf('=');
    const candidateKey = eq >= 0
      ? normalizeTemplateVariableKey(trimmed.slice(0, eq))
      : '';
    const candidateValue = eq >= 0 ? trimmed.slice(eq + 1).trim() : '';
    const startsMapping = eq >= 0
      && isTemplateVariableKey(candidateKey)
      && Boolean(candidateValue);

    if (startsMapping) {
      params[candidateKey] = candidateValue;
      lastKey = candidateKey;
      return;
    }

    // Marketing copy frequently contains "=". Unless the left-hand side is a
    // valid WhatsApp placeholder key, the full line belongs to the previous
    // parameter value instead of creating a phantom parameter.
    if (lastKey) params[lastKey] += `\n${trimmed}`;
  });

  return params;
}

export function findApprovedTemplateDefinition(inboxData, name, language = '') {
  const inbox = inboxData?.payload || inboxData || {};
  const templates = inbox.message_templates
    || inbox.templates
    || inbox.channel?.message_templates
    || inbox.provider_config?.message_templates
    || [];
  const wantedName = String(name || '').trim();
  const wantedLanguage = normalizeLanguage(language);

  const matches = (Array.isArray(templates) ? templates : []).filter((template) => {
    const templateName = template?.name || template?.template_name || template?.element_name || '';
    const status = String(template?.status || 'APPROVED').toUpperCase();
    return templateName === wantedName && status === 'APPROVED';
  });
  const template = matches.find((candidate) => (
    !wantedLanguage || normalizeLanguage(candidate.language || candidate.locale || candidate.lang) === wantedLanguage
  )) || (matches.length === 1 ? matches[0] : null);
  if (!template) return null;

  const components = Array.isArray(template.components) ? template.components : [];
  const bodyComponent = components.find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  const body = String(bodyComponent?.text || template.body || template.content || template.text || '');

  return {
    raw: template,
    name: template.name || template.template_name || template.element_name || wantedName,
    language: template.language || template.locale || template.lang || language,
    category: template.category || template.template_category || 'MARKETING',
    body,
    bodyVariables: extractTemplateVariables(body),
  };
}

export function listApprovedTemplateNames(inboxData) {
  const inbox = inboxData?.payload || inboxData || {};
  const templates = inbox.message_templates
    || inbox.templates
    || inbox.channel?.message_templates
    || inbox.provider_config?.message_templates
    || [];
  return [...new Set((Array.isArray(templates) ? templates : [])
    .filter((template) => String(template?.status || 'APPROVED').toUpperCase() === 'APPROVED')
    .map((template) => template?.name || template?.template_name || template?.element_name || '')
    .filter(Boolean))];
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}
