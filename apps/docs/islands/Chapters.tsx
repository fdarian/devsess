import { Popover } from '@base-ui/react/popover';
import { useEffect, useState } from 'react';

interface Heading {
	depth: number;
	text: string;
	slug: string;
}

interface Props {
	headings: Heading[];
	title: string;
	variant: 'mobile' | 'desktop';
}

// Matches the sticky header offset Blume's own scrollspy uses
const TRIGGER_OFFSET = 72;

function useActiveSlug(headings: Heading[]) {
	const [active, setActive] = useState(headings[0].slug);

	useEffect(() => {
		const elements = headings.map((heading) => {
			const element = document.getElementById(heading.slug);
			if (!element) {
				throw new Error(`Chapter heading #${heading.slug} is not on the page`);
			}
			return element;
		});

		const update = () => {
			const scrolledToBottom =
				window.innerHeight + window.scrollY >=
				document.documentElement.scrollHeight - 2;
			let current = 0;
			if (scrolledToBottom) {
				current = elements.length - 1;
			} else {
				elements.forEach((element, index) => {
					if (element.getBoundingClientRect().top <= TRIGGER_OFFSET) {
						current = index;
					}
				});
			}
			setActive(headings[current].slug);
		};

		update();
		window.addEventListener('scroll', update, { passive: true });
		return () => window.removeEventListener('scroll', update);
	}, [headings]);

	return active;
}

function Chapters(props: Props) {
	const active = useActiveSlug(props.headings);

	return (
		<nav className="devsess-chapters" aria-label={props.title}>
			<Popover.Root>
				<Popover.Trigger
					className="devsess-chapters-rail"
					openOnHover
					delay={50}
					closeDelay={150}
					aria-label={props.title}
				>
					{props.headings.map((heading) => (
						<span
							key={heading.slug}
							className="devsess-chapters-tick"
							data-active={heading.slug === active || undefined}
						/>
					))}
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Positioner
						className="devsess-chapters-positioner"
						side="left"
						align="start"
						sideOffset={4}
					>
						<Popover.Popup className="devsess-chapters-card">
							<ul>
								{props.headings.map((heading) => (
									<li key={heading.slug} data-depth={heading.depth}>
										<a
											href={`#${heading.slug}`}
											aria-current={
												heading.slug === active ? 'location' : undefined
											}
										>
											<span className="devsess-chapters-dash" />
											{heading.text}
										</a>
									</li>
								))}
							</ul>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</nav>
	);
}

export default function ChaptersSlot(props: Props) {
	if (props.variant !== 'desktop' || props.headings.length < 2) {
		return null;
	}
	return <Chapters {...props} />;
}
