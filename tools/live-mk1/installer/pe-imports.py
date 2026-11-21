"""Read PE import names without loading executable code (host bundle audit)."""
import struct


def imports(data):
    if data[:2] != b'MZ' or len(data) < 64:
        raise ValueError('Expected a bounded PE image')
    offset = struct.unpack_from('<I', data, 60)[0]
    if data[offset:offset + 4] != b'PE\0\0':
        raise ValueError('Invalid PE signature')
    count, optional_size = struct.unpack_from('<H12xH', data, offset + 6)
    optional = offset + 24
    magic = struct.unpack_from('<H', data, optional)[0]
    if magic not in (0x10b, 0x20b) or count > 96:
        raise ValueError('Unsupported PE geometry')
    directory = optional + (112 if magic == 0x20b else 96)
    section_table = optional + optional_size
    sections = [struct.unpack_from('<IIII', data, section_table + n * 40 + 8)
                for n in range(count)]

    def at(rva):
        for virtual_size, address, size, position in sections:
            if address <= rva < address + max(virtual_size, size):
                result = position + rva - address
                if result >= len(data):
                    break
                return result
        raise ValueError('Invalid import RVA')

    result = set()
    for index, stride, name_at in [(1, 20, 12), (13, 32, 4)]:
        rva, size = struct.unpack_from('<II', data, directory + index * 8)
        if not rva:
            continue
        pointer = at(rva)
        for n in range(min(size // stride + 1, 4096)):
            entry = data[pointer + n * stride:pointer + (n + 1) * stride]
            if len(entry) != stride:
                raise ValueError('Truncated import table')
            if not any(entry):
                break
            if index == 13 and not struct.unpack_from('<I', entry)[0] & 1:
                raise ValueError('Non-RVA delay imports are unsupported')
            name = at(struct.unpack_from('<I', entry, name_at)[0])
            end = data.find(b'\0', name, name + 256)
            if end < 0:
                raise ValueError('Unbounded import name')
            result.add(data[name:end].decode('ascii').lower())
    return sorted(result)
