import type { SegmentStatus } from '../../api/segments.api';

interface SegmentFilterProps {
  statusFilter: SegmentStatus | 'ALL';
  searchQuery: string;
  onStatusFilterChange: (status: SegmentStatus | 'ALL') => void;
  onSearchChange: (query: string) => void;
}

const statusOptions: Array<{ value: SegmentStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'NEW', label: 'New' },
  { value: 'MT', label: 'MT' },
  { value: 'EDITED', label: 'Edited' },
  { value: 'CONFIRMED', label: 'Confirmed' },
];

export default function SegmentFilter({
  statusFilter,
  searchQuery,
  onStatusFilterChange,
  onSearchChange,
}: SegmentFilterProps) {
  return (
    <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center space-x-4">
      <div className="flex-1">
        <input
          type="text"
          placeholder="Search segments..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="input w-full"
        />
      </div>
      <div className="flex items-center space-x-2">
        <label className="text-sm text-gray-700">Status:</label>
        <select
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value as SegmentStatus | 'ALL')}
          className="input"
        >
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}



