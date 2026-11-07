// "3 files": how many files an upload held.
export function countLabel(n: number): string {
	return n === 1 ? '1 file' : `${n} files`;
}
