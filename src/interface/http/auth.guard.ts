import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (CLAUDE.md, "Autenticação"): hoje não faz nada e deixa tudo passar.
 * O desenho previsto (OIDC/JWT de um IdP externo, `providerId` derivado do token) está no ARCHITECTURE.
 * Os endpoints de health ficam fora dele de propósito.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
