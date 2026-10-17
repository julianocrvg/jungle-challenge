import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  /** String decimal com escala fixa de 2, por exemplo "25.00". */
  amount: string;
  /** ISO-4217, por exemplo "BRL". */
  currency: string;
}

// Decimal.clone isola a configuração: nada depende (nem altera) o Decimal global.
// Precisão de 40 dígitos folga sobre NUMERIC(19,2), então nenhuma soma arredonda.
const Dec = Decimal.clone({ precision: 40 });

// Escala exata de 2, sem sinal, sem zeros à esquerda, no máximo 17 dígitos inteiros (cabe em NUMERIC(19,2)).
// Notação científica, NaN, Infinity, vazio e espaços não casam.
const AMOUNT_FORMAT = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_FORMAT = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Internamente um Decimal (exato, sem float); na borda, sempre string.
 * `from` só aceita valores não negativos (contratos de entrada); resultados de `subtract` e `negate`
 * podem ser negativos, mas não voltam por `from`.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_FORMAT.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid amount: expected a decimal string with 2 places, e.g. "25.00"`);
    }
    return new Money(new Dec(props.amount), Money.validCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Dec(0), Money.validCurrency(currency));
  }

  private static validCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_FORMAT.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: expected 3 uppercase letters`);
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amountString(), currency: this.currency };
  }

  toString(): string {
    return `${this.amountString()} ${this.currency}`;
  }

  // Decimal#toFixed é formatação exata de um decimal (não é Number#toFixed): sempre 2 casas, sem notação científica.
  private amountString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
