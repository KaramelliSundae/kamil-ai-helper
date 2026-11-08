import { DropdownMenu, DropdownMenuItem, FilterChip, Icon, Text } from '@expo/ui/jetpack-compose';
import { useState } from 'react';

import { courseIcon } from '../courseIcon';
import { icons } from '../icons';

const COURSE_CHIP_CHARS = 18;

/** Courses as a menu rather than a row of their own: their names are long, and the list needs the room. */
export function CoursePicker({ courses, course, onChange, all = true }: {
  courses: string[];
  course: string | null;
  onChange: (course: string | null) => void;
  /** Whether "Tüm dersler" is a choice. A table that shows one course at a time has no such thing. */
  all?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pick = (next: string | null) => {
    setOpen(false);
    onChange(next);
  };
  const name = course && course.length > COURSE_CHIP_CHARS ? `${course.slice(0, COURSE_CHIP_CHARS - 1).trimEnd()}…` : course;
  return (
    <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
      <DropdownMenu.Trigger>
        <FilterChip selected={!!course} onClick={() => setOpen(true)}>
          <FilterChip.Label>
            <Text>{name ?? 'Tüm dersler'}</Text>
          </FilterChip.Label>
          <FilterChip.TrailingIcon>
            <Icon source={icons.arrowDown} size={18} />
          </FilterChip.TrailingIcon>
        </FilterChip>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {all ? (
          <DropdownMenuItem onClick={() => pick(null)}>
            <DropdownMenuItem.LeadingIcon>
              <Icon source={icons.school} size={20} />
            </DropdownMenuItem.LeadingIcon>
            <DropdownMenuItem.Text>
              <Text>Tüm dersler</Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ) : null}
        {courses.map((option) => (
          <DropdownMenuItem key={option} onClick={() => pick(option)}>
            <DropdownMenuItem.LeadingIcon>
              <Icon source={courseIcon(option)} size={20} />
            </DropdownMenuItem.LeadingIcon>
            <DropdownMenuItem.Text>
              <Text>{option}</Text>
            </DropdownMenuItem.Text>
            {option === course ? (
              <DropdownMenuItem.TrailingIcon>
                <Icon source={icons.taskDone} size={20} />
              </DropdownMenuItem.TrailingIcon>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}
