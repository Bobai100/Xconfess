import { SetMetadata } from '@nestjs/common';

export const API_DEPRECATED_KEY = 'API_DEPRECATED_METADATA';

export interface DeprecationOptions {
  sunsetDate?: string | Date; // Date when endpoint will be shut down (RFC 1123 or ISO string)
  alternativeRoute?: string;  // Successor endpoint (e.g. /api/v2/confessions)
  documentationUrl?: string;  // Link to migration guide
  description?: string;       // Context for deprecation
}

export const ApiDeprecated = (options: DeprecationOptions = {}) =>
  SetMetadata(API_DEPRECATED_KEY, options);
