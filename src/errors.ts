/**
 * Why a pack or unpack call failed. See docs/spec.md for the full table.
 * Почему упаковка или распаковка не удалась. Полная таблица в docs/spec.md.
 */
export type PackErrorCode = 'type' | 'range' | 'overflow' | 'truncated' | 'invalid' | 'usage';

/**
 * The only error type 2pack throws for bad data. `code` says what went wrong, `path` where
 * (for example `players[3].hp`). Decoding hostile bytes throws nothing else.
 * Единственный тип ошибки 2pack для плохих данных. `code` говорит, что не так, `path` где
 * (например `players[3].hp`). Разбор враждебных байтов не бросает ничего другого.
 */
export class PackError extends Error {
    readonly code: PackErrorCode;
    /** Field names and array indexes from the root down to the failing value. / Путь от корня до значения с ошибкой. */
    readonly path: (string | number)[] = [];
    readonly #detail: string;

    constructor(code: PackErrorCode, detail: string) {
        super(detail);
        this.name = 'PackError';
        this.code = code;
        this.#detail = detail;
    }

    /** @internal Called while the error travels up through objects and arrays. */
    addPath(segment: string | number): void {
        this.path.unshift(segment);
        this.message = `${this.#detail} (at ${formatPath(this.path)})`;
    }
}

function formatPath(path: readonly (string | number)[]): string {
    let out = '';
    for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg;
    return out;
}

/** @internal */
export function fail(code: PackErrorCode, detail: string): never {
    throw new PackError(code, detail);
}
