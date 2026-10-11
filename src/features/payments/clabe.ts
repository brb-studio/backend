const WEIGHTS = [3, 7, 1];

export function isValidClabe(value: string) {
  if (!/^\d{18}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (Number(value[i]) * (WEIGHTS[i % 3] as number)) % 10;
  }
  return (10 - (sum % 10)) % 10 === Number(value[17]);
}
