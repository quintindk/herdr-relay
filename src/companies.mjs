import { randomUUID } from 'node:crypto';
import { canonical, requireValue, text } from './protocol.mjs';

export async function provisionCompany(store, api, input) {
  const id = `company:${text(input.key, 'key')}`;
  const request = { name: text(input.name, 'name'), description: input.description ?? '' };
  requireValue(typeof request.description === 'string', 'invalid_request', 'Description must be a string');
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Company provisioning key configuration changed', 409);
    if (operation.state === 'recorded') {
      const company = await api('GET', `/api/companies/${encodeURIComponent(operation.companyId)}`);
      requireValue(company.id === operation.companyId, 'company_identity_mismatch', 'Company receipt no longer matches the backend', 409);
      return operation;
    }
  } else operation = store.saveOperation({ id, runId: '', request, state: 'intent', marker: randomUUID() });
  // Paperclip company creation has no idempotency key or metadata field. Keep
  // a unique marker in the description to reconcile a lost creation response.
  const description = `${request.description}${request.description ? '\n\n' : ''}[herdr-relay-company:${operation.marker}]`;
  const companies = await api('GET', '/api/companies');
  requireValue(Array.isArray(companies), 'invalid_backend_response', 'Expected companies array', 502);
  const matches = companies.filter(company => company.description === description);
  requireValue(matches.length <= 1, 'company_identity_ambiguous', 'Multiple companies match the provisioning marker', 409);
  let company = matches[0];
  if (!company) {
    requireValue(operation.state !== 'uncertain', 'company_creation_uncertain', 'Company creation was attempted. Absence does not authorise another create.', 409);
    requireValue(!companies.some(company => company.name === request.name), 'company_name_conflict', 'A company with that name already exists. It will not be adopted by name.', 409);
    operation = store.saveOperation({ ...operation, state: 'uncertain' });
    company = await api('POST', '/api/companies', { name: request.name, description });
  }
  requireValue(typeof company.id === 'string' && company.id.length > 0 && company.name === request.name && company.description === description,
    'company_identity_mismatch', 'Company creation receipt does not match the request', 502);
  return store.saveOperation({ ...operation, state: 'recorded', companyId: company.id });
}
